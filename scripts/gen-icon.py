#!/usr/bin/env python3
"""Deck app icon — deterministic, drawn from the UI's own palette.

A stack of three tool "cards" (the deck) inside a macOS-style dark squircle;
the front card echoes the app's actual layout: a left rail with a green
status dot + a lighter tool pane. Colors are lifted from public/index.html
(#1d2530 surfaces, #4ade80 accent).

  python3 scripts/gen-icon.py            # writes icon-src.png (1024x1024)
  npm run tauri -- icon icon-src.png     # regenerates src-tauri/icons/*
"""

from PIL import Image, ImageDraw

S = 1024
# Apple's Big Sur icon grid: ~824px rounded square centered on a 1024 canvas.
MARGIN = 100
RADIUS = 185

BG_TOP = (29, 37, 48)      # #1d2530
BG_BOT = (17, 23, 31)      # #11171f
CARD_BACK = (35, 44, 54)   # #232c36
CARD_MID = (43, 53, 66)    # #2b3542
CARD_FRONT = (48, 60, 75)  # #303c4b
RAIL = (56, 70, 87)        # rail strip, a step lighter
LINE = (139, 152, 165)     # #8b98a5 muted ink
ACCENT = (74, 222, 128)    # #4ade80


def rounded(draw: ImageDraw.ImageDraw, box, r, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def main() -> None:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Squircle background with a vertical gradient (drawn as banded fills
    # clipped by an alpha mask so edges stay clean).
    grad = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    x0, y0, x1, y1 = MARGIN, MARGIN, S - MARGIN, S - MARGIN
    for i in range(y0, y1):
        t = (i - y0) / (y1 - y0)
        col = tuple(int(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOT)) + (255,)
        gd.line([(x0, i), (x1, i)], fill=col)
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([x0, y0, x1, y1], radius=RADIUS, fill=255)
    img.paste(grad, (0, 0), mask)

    # Hairline top-edge highlight on the squircle.
    d.rounded_rectangle([x0, y0, x1, y1], radius=RADIUS,
                        outline=(255, 255, 255, 18), width=3)

    # ── The deck: three stacked cards, fanned by offset ──────────────────
    cw, ch, cr = 480, 420, 36
    cx, cy = S // 2, S // 2 + 24  # optical center, slightly low

    # back card (up-right)
    rounded(d, [cx - cw // 2 + 64, cy - ch // 2 - 88,
                cx + cw // 2 + 64, cy + ch // 2 - 88], cr, CARD_BACK + (255,))
    # middle card (up-left-ish)
    rounded(d, [cx - cw // 2 + 4, cy - ch // 2 - 44,
                cx + cw // 2 + 4, cy + ch // 2 - 44], cr, CARD_MID + (255,))

    # front card with soft drop shadow
    fx0, fy0 = cx - cw // 2 - 56, cy - ch // 2
    fx1, fy1 = cx + cw // 2 - 56, cy + ch // 2
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle([fx0 + 10, fy0 + 22, fx1 + 10, fy1 + 22], radius=cr,
                         fill=(0, 0, 0, 110))
    shadow = shadow.filter(__import__("PIL.ImageFilter", fromlist=["GaussianBlur"]).GaussianBlur(18))
    img.paste(shadow, (0, 0), shadow)
    d = ImageDraw.Draw(img)
    rounded(d, [fx0, fy0, fx1, fy1], cr, CARD_FRONT + (255,),
            outline=(255, 255, 255, 22), width=2)

    # front card interior = the app layout: left rail + pane
    rail_w = 150
    rounded(d, [fx0 + 22, fy0 + 22, fx0 + 22 + rail_w, fy1 - 22], 20, RAIL + (255,))
    # status dot on the rail
    dot_r = 26
    dcx, dcy = fx0 + 22 + rail_w // 2, fy0 + 78
    d.ellipse([dcx - dot_r, dcy - dot_r, dcx + dot_r, dcy + dot_r], fill=ACCENT + (255,))
    # rail entries (muted bars)
    for i in range(3):
        yy = fy0 + 148 + i * 64
        d.rounded_rectangle([fx0 + 52, yy, fx0 + 22 + rail_w - 30, yy + 22],
                            radius=11, fill=LINE + (90,))
    # pane content lines
    px0 = fx0 + 22 + rail_w + 26
    for i, w in enumerate((0.86, 0.62, 0.74)):
        yy = fy0 + 64 + i * 78
        d.rounded_rectangle([px0, yy, px0 + int((fx1 - 22 - px0) * w), yy + 26],
                            radius=13, fill=LINE + (70 if i else 120,))
    # a green "running" tick in the pane's bottom-right
    d.rounded_rectangle([fx1 - 130, fy1 - 74, fx1 - 46, fy1 - 46], radius=14,
                        fill=ACCENT + (230,))

    img.save("icon-src.png")
    print("wrote icon-src.png (1024x1024)")


if __name__ == "__main__":
    main()
