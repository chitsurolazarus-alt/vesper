"""One-off script that draws the Vesper app icon (reactor-core motif matching
the HUD palette) and rasterizes it to the PNG sizes a manifest/apple-touch-icon
needs. Not part of the runtime app — run once, commit the PNG output, discard
or keep this script for regenerating later."""

import math
from PIL import Image, ImageDraw, ImageFilter

BG = (6, 10, 16, 255)          # --bg
CYAN = (61, 220, 255, 255)     # --cyan
CYAN_DIM = (28, 122, 153, 255) # --cyan-dim
AMBER = (255, 166, 77, 255)    # --amber


def draw_icon(size, maskable=False):
    # Supersample for smooth edges/glow, then downscale.
    S = size * 4
    img = Image.new("RGBA", (S, S), BG)
    draw = ImageDraw.Draw(img)

    cx = cy = S / 2
    # Maskable icons get safe-area padding (content kept within the inner
    # ~80% so platform masks don't clip it); plain icons can fill more.
    core_r = S * (0.30 if maskable else 0.36)

    # Soft radial backdrop glow behind the core.
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.ellipse([cx - core_r * 1.7, cy - core_r * 1.7, cx + core_r * 1.7, cy + core_r * 1.7],
                  fill=(61, 220, 255, 90))
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.06))
    img.alpha_composite(glow)

    # Three tilted rings (echoing the .ring3d / .core3d look).
    ring_specs = [
        (core_r * 1.55, core_r * 0.62, CYAN_DIM, 255, S * 0.012),
        (core_r * 1.35, core_r * 0.50, CYAN, 200, S * 0.010),
        (core_r * 1.15, core_r * 0.40, AMBER, 180, S * 0.008),
    ]
    for rx, ry, color, alpha, width in ring_specs:
        ring = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        rdraw = ImageDraw.Draw(ring)
        rdraw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], outline=color[:3] + (alpha,), width=max(2, int(width)))
        img.alpha_composite(ring)

    # Glowing central sphere.
    sphere_glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sgdraw = ImageDraw.Draw(sphere_glow)
    sgdraw.ellipse([cx - core_r * 1.15, cy - core_r * 1.15, cx + core_r * 1.15, cy + core_r * 1.15],
                   fill=(61, 220, 255, 140))
    sphere_glow = sphere_glow.filter(ImageFilter.GaussianBlur(S * 0.035))
    img.alpha_composite(sphere_glow)

    sphere = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(sphere)
    steps = 40
    for i in range(steps, 0, -1):
        t = i / steps
        r = core_r * t
        # Interpolate from near-white core to cyan edge, matching the CSS
        # radial-gradient(#eafcff -> cyan -> transparent) on .sphere.
        if t > 0.85:
            col = (234, 252, 255)
        else:
            f = t / 0.85
            col = tuple(int(CYAN[c] + (255 - CYAN[c]) * (1 - f) * 0.15) for c in range(3))
        sdraw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col + (255,))
    img.alpha_composite(sphere)

    # A small dark inner shadow crescent for a bit of sphere depth.
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    shdraw = ImageDraw.Draw(shadow)
    off = core_r * 0.28
    shdraw.ellipse([cx - core_r + off, cy - core_r + off, cx + core_r + off, cy + core_r + off],
                   fill=(0, 0, 0, 70))
    shadow = shadow.filter(ImageFilter.GaussianBlur(S * 0.05))
    mask = Image.new("L", (S, S), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.ellipse([cx - core_r, cy - core_r, cx + core_r, cy + core_r], fill=255)
    shadow.putalpha(Image.composite(shadow.split()[3], Image.new("L", (S, S), 0), mask))
    img.alpha_composite(shadow)

    return img.resize((size, size), Image.LANCZOS)


for size in (192, 512):
    draw_icon(size).save(f"icon-{size}.png")

draw_icon(512, maskable=True).save("icon-512-maskable.png")
draw_icon(180).save("apple-touch-icon.png")

print("done")
