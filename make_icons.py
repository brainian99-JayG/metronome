# 앱 아이콘 생성 스크립트 (한 번만 실행하면 icons/ 폴더가 만들어짐)
# 실행:  python make_icons.py
from PIL import Image, ImageDraw
import os, math

BG = (16, 20, 24, 255)      # #101418
TEAL = (0, 194, 178, 255)   # #00c2b2
GLOW = (42, 245, 226, 255)  # #2af5e2
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
S = 1024  # 원본 해상도(축소해서 저장)


def draw_metronome(d, cx, cy, scale):
    """메트로놈 본체(사다리꼴) + 진자 + 추"""
    w = 300 * scale       # 아랫변 절반
    tw = 96 * scale       # 윗변 절반
    h = 330 * scale       # 높이 절반
    body = [
        (cx - w, cy + h),
        (cx + w, cy + h),
        (cx + tw, cy - h),
        (cx - tw, cy - h),
    ]
    d.polygon(body, outline=TEAL, width=int(30 * scale))

    # 진자(약간 기울어진 막대)
    ang = math.radians(11)
    top = (cx + math.sin(ang) * h * 1.02, cy - h * 0.86)
    bot = (cx - math.sin(ang) * h * 0.30, cy + h * 0.62)
    d.line([bot, top], fill=GLOW, width=int(26 * scale))

    # 추
    ww = 84 * scale
    wh = 46 * scale
    mx = cx + math.sin(ang) * h * 0.10
    my = cy - h * 0.06
    d.rounded_rectangle(
        [mx - ww, my - wh, mx + ww, my + wh],
        radius=int(14 * scale), fill=GLOW
    )


def make(size, maskable=False, rounded=True):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if maskable:
        d.rectangle([0, 0, S, S], fill=BG)          # 잘려도 되도록 꽉 채움
        draw_metronome(d, S / 2, S / 2, 0.62)       # 안전영역 안쪽으로 축소
    else:
        r = int(S * 0.22) if rounded else 0
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=BG)
        draw_metronome(d, S / 2, S / 2 + S * 0.01, 0.86)

    img = img.resize((size, size), Image.LANCZOS)
    return img


os.makedirs(OUT, exist_ok=True)
make(192).save(os.path.join(OUT, "icon-192.png"))
make(512).save(os.path.join(OUT, "icon-512.png"))
make(512, maskable=True).save(os.path.join(OUT, "icon-512-maskable.png"))
make(180, rounded=False).save(os.path.join(OUT, "apple-touch-icon-180.png"))  # iOS는 자체적으로 모서리를 깎음
print("아이콘 생성 완료 ->", OUT)
