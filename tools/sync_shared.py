"""Inject the shared site navigation, styles and field-guide runtime into every page.

Run from the repo root after editing anything in shared/ or adding a guide:

    python tools/sync_shared.py

Everything injected is wrapped in <!--nd:begin NAME--> ... <!--nd:end NAME--> markers,
so the script is safe to run repeatedly: old blocks are replaced, never duplicated.
To add a guide, add it to shared/site.json (label, href, iNaturalist ancestor taxon id,
sound-button label) and re-run.
"""
import html
import json
import re
import os
import sys
import time
from pathlib import Path


def save(p, text):
    """Write via a temp file and swap it in, retrying: on Windows, antivirus or a
    running preview server can briefly lock large files."""
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(text, encoding="utf-8", newline="")
    for attempt in range(10):
        try:
            os.replace(tmp, p)
            return
        except OSError:
            time.sleep(0.5 * (attempt + 1))
    tmp.unlink(missing_ok=True)
    raise OSError(f"could not write {p.name} (file locked?)")

ROOT = Path(__file__).resolve().parent.parent
SHARED = ROOT / "shared"
SITE = json.loads((SHARED / "site.json").read_text(encoding="utf-8"))


def read(name):
    return (SHARED / name).read_text(encoding="utf-8")


NAV_CSS, NAV_JS = read("nav.css"), read("nav.js")
GUIDE_CSS, GUIDE_JS = read("guide.css"), read("guide.js")


def block(name, content):
    return f"<!--nd:begin {name}-->{content}<!--nd:end {name}-->"


def strip_blocks(text):
    # "keep-" blocks replaced original markup, so they are refreshed in place instead.
    return re.sub(r"\n?<!--nd:begin ((?!keep-)[\w-]+)-->.*?<!--nd:end \1-->", "", text, flags=re.S)


def nav_html(current):
    esc = html.escape
    items = [f'<li><a href="{SITE["home"]}"{" class=\"nd-current\"" if current == SITE["home"] else ""}>Home</a></li>']
    for sec in SITE["sections"]:
        links = [i for i in sec["items"] if not i.get("hidden")]
        is_cur = any(i["href"] == current for i in sec["items"])
        extra = " nd-inat" if sec["label"].startswith("iNaturalist") else ""
        if len(links) == 1 and not links[0].get("desc"):
            i = links[0]
            cls = ' class="nd-current"' if is_cur else ""
            items.append(f'<li><a href="{i["href"]}"{cls}>{esc(sec["label"])}</a></li>')
            continue
        inner = "".join(
            f'<a href="{i["href"]}"{" class=\"nd-current\" aria-current=\"page\"" if i["href"] == current else ""}>'
            f'{esc(i["label"])}{"<small>" + esc(i["desc"]) + "</small>" if i.get("desc") else ""}</a>'
            for i in links
        )
        items.append(
            f'<li><details class="nd-drop{extra}{" nd-current" if is_cur else ""}">'
            f'<summary>{esc(sec["label"])}</summary><div class="nd-panel">{inner}</div></details></li>'
        )
    return (
        '<nav class="nd-nav" aria-label="Field guides">'
        '<div class="nd-nav-inner">'
        f'<a class="nd-brand" href="{SITE["home"]}">{esc(SITE["brand"])}</a>'
        '<button class="nd-toggle" type="button" aria-expanded="false" aria-controls="nd-menu">Menu</button>'
        f'<ul class="nd-menu" id="nd-menu">{"".join(items)}</ul>'
        "</div></nav>"
    )


def insert_after_body(text, content):
    m = re.search(r"<body[^>]*>", text)
    if not m:
        raise ValueError("no <body>")
    return text[: m.end()] + "\n" + content + text[m.end():]


def insert_before_head_end(text, content):
    i = text.find("</head>")
    if i < 0:
        raise ValueError("no </head>")
    return text[:i] + "\n" + content + text[i:]


INTRO_TOOLS = (
    '<div style="text-align:center;margin-top:1rem">'
    '<button class="refresh-btn refresh-inat-btn" onclick="refreshInatData()">↻ Refresh iNaturalist Counts</button>'
    '<button class="refresh-btn" onclick="refreshAudio(this)" style="margin-left:.4rem">▶ Refresh Sounds</button>'
    '<span class="refresh-status" style="display:block;margin-top:.4rem"></span>'
    '<div class="nd-counts-note"></div>'
    "</div>"
)
SORT_OPTIONS = (
    '<option value="quality_grade=research&amp;order_by=votes&amp;order=desc">Most Favorited</option>'
    '<option value="quality_grade=any&amp;order_by=votes&amp;order=desc">Most Voted On</option>'
    '<option value="quality_grade=research&amp;order_by=observed_on&amp;order=desc">Most Recent</option>'
    '<option value="quality_grade=research&amp;order_by=votes&amp;order=desc&amp;has[]=notes&amp;identified=true">Most Data</option>'
)
GALLERY_TOOLS = (
    '<button class="refresh-btn refresh-inat-btn" onclick="refreshInatData()">↻ Refresh iNat Counts</button>'
    '<span class="photo-controls" style="margin-left:auto">'
    '<label class="photo-controls-label" for="photoSortGallery">Sort:</label>'
    f'<select id="photoSortGallery" class="photo-sort-select" title="Photo source">{SORT_OPTIONS}</select>'
    '<button class="refresh-btn refresh-photo-btn" onclick="refreshPhotos(this)" '
    'title="Fetch the best CC-licensed photo for each species from iNaturalist (requires internet)">↻ Refresh Photos</button>'
    "</span>"
    '<span class="refresh-status"></span>'
)
AUDIO_BAR = (
    '<div id="audio-bar"><audio id="audio-player" controls preload="none"></audio>'
    '<span id="audio-label"></span>'
    '<button id="audio-close" onclick="stopAudio()" title="Close">&#x2715;</button></div>'
)
PICKER = (
    '<div class="photo-picker-overlay hidden" id="photo-picker" onclick="closePhotoPicker(event)">'
    '<div class="photo-picker-box" onclick="event.stopPropagation()">'
    '<div class="picker-hdr"><h3 id="picker-title">Choose Photo</h3><div class="picker-hdr-btns">'
    '<button class="btn-picker-reset" onclick="resetPickerPhoto()">&#8635; Reset to Default</button>'
    '<button class="btn-picker-close" onclick="closePhotoPicker()">&times;</button></div></div>'
    '<div class="picker-sort-bar"><span class="picker-sort-label">Sort:</span>'
    '<button class="picker-sort-btn active" onclick="setPickerSort(0,this)">Most Favorited</button>'
    '<button class="picker-sort-btn" onclick="setPickerSort(1,this)">Most Voted</button>'
    '<button class="picker-sort-btn" onclick="setPickerSort(2,this)">Most Recent</button>'
    '<button class="picker-sort-btn" onclick="setPickerSort(3,this)">Most Data</button></div>'
    '<p class="picker-hint">Click a photo to use it everywhere this species appears. Your choice is saved in this browser.</p>'
    '<div class="picker-grid" id="picker-grid"></div></div></div>'
)


def ensure_document(text):
    """Most guides were saved as fragments (no doctype/head/body). Give every guide the
    same standards-mode skeleton with charset + viewport so it renders properly on
    GitHub Pages and on phones."""
    bom = "﻿" if text.startswith("﻿") else ""
    doc = text[len(bom):]
    if not doc.lstrip().lower().startswith("<!doctype"):
        doc = ('<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n'
               '<meta name="viewport" content="width=device-width,initial-scale=1.0">\n' + doc)
    if not re.search(r"<body[\s>]", doc):
        i = doc.find('<header class="guide-header"')
        if i < 0:
            raise ValueError("guide header not found")
        doc = doc[:i].rstrip() + "\n</head>\n<body>\n\n" + doc[i:]
    if "</html>" not in doc[-200:]:
        doc = doc.rstrip() + "\n</body>\n</html>\n"
    return bom + doc


def patch_guide(text, item):
    text = ensure_document(text)
    # One-time clean-ups (no-ops once applied).
    text = re.sub(r'\s*<a class="home-link" href="index.html">All Field Guides</a>', "", text)
    text = re.sub(r"(?m)^restoreCachedPhotos\(\);\n", "", text)  # Frog: superseded by shared photo cache

    # Uniform intro toolbar: counts + sounds + live-count note.
    intro = text.find('id="key-intro"')
    step = text.find('id="key-step"')
    if intro < 0 or step < 0:
        raise ValueError("key-intro/key-step not found")
    seg = text[intro:step]
    new = block("keep-intro-tools", INTRO_TOOLS)
    if "nd:begin keep-intro-tools" in seg:
        seg2 = re.sub(r"<!--nd:begin keep-intro-tools-->.*?<!--nd:end keep-intro-tools-->",
                      lambda m: new, seg, flags=re.S)
    else:
        seg2, n = re.subn(
            r'<div style="text-align:center;margin-top:1rem">(?:(?!id="key-step").)*?'
            r'<span class="refresh-status" style="display:block;margin-top:\.4rem"></span>\s*</div>',
            lambda m: new, seg, count=1, flags=re.S)
        if n != 1:
            raise ValueError("intro toolbar not found")
    text = text[:intro] + seg2 + text[step:]

    # Gallery toolbar (refresh counts/photos) where missing, and live-count note.
    if 'id="photoSortGallery"' not in text:
        m = re.search(r'<div class="filter-bar">.*?(</div>)', text, flags=re.S)
        text = text[: m.start(1)] + block("gallery-tools", GALLERY_TOOLS) + text[m.start(1):]
    m = re.search(r'<div class="gallery-header">.*?(</div>)', text, flags=re.S)
    text = text[: m.start(1)] + block("gallery-note", '<div class="nd-counts-note" style="text-align:inherit"></div>') + text[m.start(1):]

    # Sound player + photo picker markup where missing.
    extras = ""
    if 'id="audio-bar"' not in text:
        extras += AUDIO_BAR
    if 'id="photo-picker"' not in text:
        extras += PICKER
    if extras:
        i = text.find('<footer class="guide-footer"')
        text = text[:i] + "\n" + block("guide-markup", extras) + text[i:]

    cfg = {"id": Path(item["href"]).stem, "ancestor": item["ancestor"], "placeId": 27, "soundLabel": item["sound"]}
    head = block("head", f"<style>\n{NAV_CSS}\n{GUIDE_CSS}</style>")
    script = block("script", f"<script>\nwindow.ND_GUIDE = {json.dumps(cfg)};\n{GUIDE_JS}</script>\n<script>\n{NAV_JS}</script>")
    text = insert_before_head_end(text, head)
    text = insert_after_body(text, block("nav", nav_html(item["href"])))
    end = text.rfind("</script>") + len("</script>")
    return text[:end] + "\n" + script + text[end:]


def patch_plain(text, current):
    head = block("head", f"<style>\n{NAV_CSS}</style>")
    text = insert_before_head_end(text, head)
    text = insert_after_body(text, block("nav", nav_html(current)))
    script = block("script", f"<script>\n{NAV_JS}</script>")
    i = text.rfind("</body>")
    return (text[:i] + "\n" + script + text[i:]) if i >= 0 else text + "\n" + script


def main():
    guides = [i for s in SITE["sections"] for i in s["items"] if "ancestor" in i]
    others = [SITE["home"]] + [i["href"] for s in SITE["sections"] for i in s["items"] if "ancestor" not in i]
    for item in guides:
        p = ROOT / item["href"]
        if not p.exists():
            print("skip (missing)", p.name); continue
        src = p.read_text(encoding="utf-8")
        out = patch_guide(strip_blocks(src), item)
        if out != src:
            save(p, out)
        print("guide ", p.name)
    for href in others:
        p = ROOT / href
        if not p.exists():
            print("skip (missing)", href); continue
        src = p.read_text(encoding="utf-8")
        out = patch_plain(strip_blocks(src), href)
        if out != src:
            save(p, out)
        print("page  ", p.name)


if __name__ == "__main__":
    sys.exit(main())
