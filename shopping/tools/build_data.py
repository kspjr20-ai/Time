#!/usr/bin/env python3
"""Gera shopping/data/mall.json e shopping/maps/*.webp a partir dos dados
brutos do mapa oficial (baixados por fetch_sources.sh).

Uso: python3 build_data.py <pasta_raw> <pasta_shopping>

Coordenadas de saída estão em pixels da imagem de cada piso
(1 px = 8 unidades do mapa de origem).
"""
import json
import math
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

RAW = Path(sys.argv[1])
OUT = Path(sys.argv[2])
S = 8.0                      # unidades de origem por pixel (zoom 4 dos tiles)
UNITS_PER_M = 76.0           # escala aproximada do mapa de origem
SNAP = 60.0                  # tolerância (unidades) para reaproveitar um nó
# id de origem -> (id, nome, nível)
FLOORS = {"3": ("G1", "G1 · Garagem", 0), "0": ("L1", "L1", 1),
          "1": ("L2", "L2", 2), "2": ("L3", "L3", 3)}
TRANS = {"escalator": "escalator", "lift": "elevator", "gate": "ramp"}

GROUPS = [
    ("Facilidades", r"banheiro|cadeira de rodas|atendimento ao cliente|espaço família|espaço cliente|pagamento de estacionamento|portaria|estacionamento de motos|carregadores|aquário|espaço cidadania"),
    ("Alimentação", r"fast-food|lanches|restaurante|docerias|self service|cafés|açaí|com serviço|alimenta"),
    ("Lazer", r"parques e games|cinemas|parque brincar|museu|natal|noel"),
    ("Calçados", r"calçados"),
    ("Moda", r"moda|surfwear|vestuário|acessórios e artigos para viagens"),
    ("Beleza", r"perfumaria|estétic|massagem|cosm"),
    ("Óticas e joias", r"óticas|joalheria|semijoias|relojoaria"),
    ("Tecnologia", r"telefonia|eletrônicos|informática"),
    ("Serviços", r"serviços|banco|lotérica|chaveiro|agência|farmácias|foto|educação|ensino|veículos|conveniência"),
    ("Casa", r"colchões|lar|móveis|magazines|brinquedos|livraria|artigos diversos|supermercado"),
]


def norm(s):
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def group_of(*texts):
    t = " ".join(x.lower() for x in texts if x)
    for g, rx in GROUPS:
        if re.search(rx, t):
            return g
    return "Outros"


def proj(p, a, b):
    """Ponto de a-b mais próximo de p -> (dist, t, ponto)."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2))
    q = (a[0] + t * dx, a[1] + t * dy)
    return math.hypot(p[0] - q[0], p[1] - q[1]), t, q


def sample_ring(pts, step=40.0):
    out = []
    for i, a in enumerate(pts):
        b = pts[(i + 1) % len(pts)]
        n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / step))
        out += [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(n)]
    return out


def inside(p, ring):
    c = False
    for i, a in enumerate(ring):
        b = ring[(i + 1) % len(ring)]
        if (a[1] > p[1]) != (b[1] > p[1]) and p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]:
            c = not c
    return c


class Graph:
    def __init__(self):
        self.nodes = []            # dict(f, x, y, t)  (unidades de origem)
        self.edges = {}            # (a, b) ordenado -> tipo
        self.by_floor = defaultdict(list)

    def add_node(self, f, x, y, t="c"):
        self.nodes.append({"f": f, "x": x, "y": y, "t": t})
        self.by_floor[f].append(len(self.nodes) - 1)
        return len(self.nodes) - 1

    def node_at(self, f, x, y, tol=1.0):
        for i in self.by_floor[f]:
            n = self.nodes[i]
            if n["t"] != "door" and math.hypot(n["x"] - x, n["y"] - y) <= tol:
                return i
        return None

    def add_edge(self, a, b, t="walk"):
        if a != b:
            self.edges.setdefault((min(a, b), max(a, b)), t)

    def attach(self, f, p):
        """Liga o ponto p à malha de corredores do piso; devolve o nó usado."""
        i = self.node_at(f, p[0], p[1], SNAP)
        if i is not None:
            return i
        best = None
        for (a, b), t in self.edges.items():
            if t != "walk":
                continue
            na, nb = self.nodes[a], self.nodes[b]
            if na["f"] != f or nb["f"] != f or "door" in (na["t"], nb["t"]):
                continue
            d, tt, q = proj(p, (na["x"], na["y"]), (nb["x"], nb["y"]))
            if best is None or d < best[0]:
                best = (d, a, b, q)
        if best is None:
            return None
        _, a, b, q = best
        for e in (a, b):
            if math.hypot(self.nodes[e]["x"] - q[0], self.nodes[e]["y"] - q[1]) <= SNAP:
                return e
        m = self.add_node(f, q[0], q[1])
        del self.edges[(min(a, b), max(a, b))]
        self.add_edge(a, m)
        self.add_edge(m, b)
        return m


def main():
    mp = json.loads((RAW / "map.json").read_text())
    interests = json.loads((RAW / "interests.json").read_text())
    site = json.loads((RAW / "stores_site.json").read_text()) if (RAW / "stores_site.json").exists() else []
    site_cat = {norm(s["name"]): s["cat"] for s in site}

    global MAP_H
    MAP_H = mp["local"]["mapHeight"]

    g = Graph()
    for p in mp["paths"]["paths"]:
        f = FLOORS[str(p[2])][0]
        ids = []
        for c in (p[0], p[1]):
            i = g.node_at(f, c[0], c[1])
            ids.append(i if i is not None else g.add_node(f, c[0], c[1]))
        g.add_edge(ids[0], ids[1])

    # Trocas de piso
    for t in mp["paths"]["transitions"]:
        kind = TRANS.get(t.get("transitionType"), "stairs")
        fa = FLOORS[str(t["floor"])][0]
        a = g.attach(fa, t["coords"])
        for d in ("up", "down"):
            if d not in t:
                continue
            fb = FLOORS[str(t[d]["floorId"])][0]
            b = g.attach(fb, t[d]["coords"])
            if a is None or b is None:
                continue
            for i in (a, b):
                if g.nodes[i]["t"] == "c":
                    g.nodes[i]["t"] = kind
            g.add_edge(a, b, kind)

    # Lojas e pontos de interesse
    pois = []
    for key in sorted(interests):
        v = interests[key]
        if "x" not in v:
            continue
        f = FLOORS[str(v["floor"])][0]
        c = (float(v["x"]), float(v["y"]))
        # polígonos vêm com o eixo Y invertido em relação aos demais dados
        ring = [(seg[0][0], MAP_H - seg[0][1]) for seg in v.get("polygon", [])]
        door = c
        if len(ring) >= 3:
            best = None
            walk = [(a, b) for (a, b), t in g.edges.items()
                    if t == "walk" and g.nodes[a]["f"] == f and g.nodes[a]["t"] != "door" and g.nodes[b]["t"] != "door"]
            for s in sample_ring(ring):
                for a, b in walk:
                    d, _, q = proj(s, (g.nodes[a]["x"], g.nodes[a]["y"]), (g.nodes[b]["x"], g.nodes[b]["y"]))
                    if best is None or d < best[0]:
                        best = (d, s, q)
            if best:
                # corredor que atravessa o polígono (quiosque): usa o centro
                door = c if inside(best[2], ring) else best[1]
        at = g.attach(f, door)
        if at is None:
            continue
        dn = g.add_node(f, door[0], door[1], "door")
        g.add_edge(at, dn)
        tags = v.get("tags") or []
        title = re.sub(r"\s+", " ", v["title"]).strip()
        cat = site_cat.get(norm(title), "")
        tag0 = tags[0] if tags and norm(tags[0]) != norm(title) else ""
        pois.append({
            "id": "p%d" % len(pois), "name": title, "f": f,
            "x": round(c[0] / S), "y": round(c[1] / S), "node": dn,
            "group": group_of(tag0, cat, title if not tag0 and not cat else ""),
            "cat": (tag0 or cat).capitalize(),
            "poly": [round(k / S) for pt in ring for k in pt],
        })

    # Nomes repetidos (ex.: três "Banheiro L1") recebem numeração
    seen = defaultdict(list)
    for p in pois:
        seen[(p["name"].lower().strip(), p["f"])].append(p)
    for (_, _), lst in seen.items():
        if len(lst) > 1:
            for k, p in enumerate(sorted(lst, key=lambda q: q["x"]), 1):
                p["name"] = "%s (%d)" % (p["name"], k)

    floors = []
    for src, (fid, name, level) in sorted(FLOORS.items(), key=lambda kv: kv[1][2]):
        floors.append({"id": fid, "name": name, "level": level,
                       "image": "maps/%s.webp" % fid.lower(),
                       "width": math.ceil(mp["local"]["mapWidth"] / S),
                       "height": math.ceil(mp["local"]["mapHeight"] / S)})

    data = {
        "meta": {
            "name": "Salvador Norte Shopping",
            "schema": 1,
            "pxPerMeter": round(UNITS_PER_M / S, 2),
            "source": "Mapa oficial (salvadornorteshopping.com.br/mapa-de-lojas)",
        },
        "floors": floors,
        "nodes": [{"id": i, "f": n["f"], "x": round(n["x"] / S, 1), "y": round(n["y"] / S, 1), "t": n["t"]}
                  for i, n in enumerate(g.nodes)],
        "edges": [{"a": a, "b": b, "t": t} for (a, b), t in sorted(g.edges.items())],
        "pois": sorted(pois, key=lambda p: norm(p["name"])),
    }
    (OUT / "data").mkdir(parents=True, exist_ok=True)
    (OUT / "data" / "mall.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))

    # Imagens dos pisos (mosaico dos tiles oficiais)
    tiles = RAW / "tiles"
    if tiles.exists():
        from PIL import Image
        (OUT / "maps").mkdir(exist_ok=True)
        for src, (fid, _, _) in FLOORS.items():
            w, h = floors[0]["width"], floors[0]["height"]
            im = Image.new("RGBA", (12 * 256, 9 * 256), (255, 255, 255, 255))
            for x in range(12):
                for y in range(9):
                    im.alpha_composite(Image.open(tiles / f"{src}_{x}_{y}.png").convert("RGBA"), (x * 256, y * 256))
            im.convert("RGB").crop((0, 0, w, h)).save(OUT / "maps" / f"{fid.lower()}.webp", quality=82, method=6)

    # Relatório
    names = {norm(p["name"]) for p in pois}
    missing = [s["name"] for s in site if norm(s["name"]) not in names]
    print("nós", len(data["nodes"]), "arestas", len(data["edges"]), "pontos", len(pois))
    print("trocas de piso", sum(1 for e in data["edges"] if e["t"] != "walk"))
    print("lojas do site sem posição no mapa (%d):" % len(missing), ", ".join(sorted(set(missing))))


if __name__ == "__main__":
    main()
