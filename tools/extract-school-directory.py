"""Read the supplied DOCX as data; emit a reviewed JSON school/source directory."""
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
with zipfile.ZipFile(source) as archive:
    tree = ET.fromstring(archive.read("word/document.xml"))
schools = []
for table in tree.findall(".//w:tbl", ns):
    for row in table.findall("w:tr", ns):
        cells = [" ".join(t.text or "" for t in cell.findall(".//w:t", ns)).strip() for cell in row.findall("w:tc", ns)]
        if len(cells) != 3:
            continue
        match = re.match(r"^(\d{3})\s+(.+?)\s*(985[及、，/\s]*)?211$", cells[0])
        if not match:
            continue
        code, name = match.group(1), match.group(2).strip()
        urls = re.findall(r"https?://[^\s\u4e00-\u9fff]+", cells[1])
        homepage = re.findall(r"https?://[^\s\u4e00-\u9fff]+", cells[2])
        if len(urls) != 1 or not homepage:
            raise ValueError(f"Review source URLs for {code}: {cells}")
        schools.append({"id": "bjtu" if name == "北京交通大学" else f"school_{code}", "name": name,
                        "directoryCode": code, "tags": ["985", "211"] if match.group(3) else ["211"],
                        "announcementUrl": urls[0], "homepage": homepage[0], "directoryNote": cells[2]})
if len(schools) != 115 or len({school["id"] for school in schools}) != 115:
    raise ValueError(f"Unexpected directory rows: {len(schools)}")
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(schools, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"schools": len(schools), "sample": schools[:2], "bjtu": [s for s in schools if s["id"] == "bjtu"]}, ensure_ascii=False))
