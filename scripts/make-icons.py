"""Export the approved logo at the original UXP filenames and dimensions.
Requires Python 3 and Pillow (python -m pip install Pillow).
"""
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
master = Image.open(root / 'src/assets/sliceman-logo.png').convert('RGBA')
# Fit the visible mark; ignore near-transparent antialiasing when measuring bounds.
bounds = master.getchannel('A').point(lambda a: 255 if a >= 128 else 0).getbbox()
assert bounds, 'Logo must contain visible pixels'
glyph = master.crop(bounds)
out = root / 'src/icons'
out.mkdir(exist_ok=True)
for base, size in [('panelIcon-dark', 23), ('panelIcon-light', 23), ('pluginIcon', 24)]:
    for suffix, scale in [('', 1), ('@1x', 1), ('@2x', 2)]:
        n = size * scale
        margin = 2 * scale
        mark = glyph.copy()
        mark.thumbnail((n - 2 * margin, n - 2 * margin), Image.Resampling.LANCZOS)
        canvas = Image.new('RGBA', (n, n))
        canvas.alpha_composite(mark, ((n - mark.width) // 2, (n - mark.height) // 2))
        canvas.save(out / f'{base}{suffix}.png')
        assert canvas.getpixel((0, 0))[3] == 0
        print(f'{base}{suffix}.png: {n} x {n}, RGBA')
