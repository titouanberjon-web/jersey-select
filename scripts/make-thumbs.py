#!/usr/bin/env python3
"""Génère les miniatures WebP utilisées par les grilles du site (catalogue, populaires, favoris).

Usage : python3 scripts/make-thumbs.py
À relancer après avoir ajouté un maillot : chaque `frontImage` de index.html
reçoit une miniature dans images/thumbs/<nom>.webp (480 px max).
Si une miniature manque, le site affiche automatiquement l'image d'origine.
Nécessite Pillow : pip install Pillow
"""
import os, re, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
srcs = sorted(set(re.findall(r"frontImage:\s*'([^']+)'", html)))
out_dir = os.path.join(ROOT, 'images', 'thumbs')
os.makedirs(out_dir, exist_ok=True)
made = skipped = missing = 0
for src in srcs:
    path = os.path.join(ROOT, src)
    if not os.path.exists(path):
        missing += 1
        print('introuvable :', src, file=sys.stderr)
        continue
    name = os.path.splitext(os.path.basename(src))[0] + '.webp'
    dest = os.path.join(out_dir, name)
    if os.path.exists(dest) and os.path.getmtime(dest) >= os.path.getmtime(path):
        skipped += 1
        continue
    im = Image.open(path)
    im = im.convert('RGBA') if im.mode in ('P', 'LA', 'RGBA') or 'transparency' in im.info else im.convert('RGB')
    im.thumbnail((480, 480), Image.LANCZOS)
    im.save(dest, 'WEBP', quality=78, method=6)
    made += 1
print(f'{made} miniatures créées, {skipped} déjà à jour, {missing} images introuvables')
