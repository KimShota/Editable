#!/usr/bin/env python3
"""
Puts real product footage onto a generated device's green screen, frame by
frame. The generated clip shows a laptop whose display is solid chroma
green; for every frame this finds that green quad, warps the matching
footage frame into it with a perspective transform, and keys it in, so a
hand or finger crossing the screen stays in front of the footage.

numpy only (no OpenCV/scipy): frames stream through ffmpeg as raw RGB.

  greenscreen.py <clip.mp4> <footage.mp4> <footage_start> <footage_end> <out.mp4>
  greenscreen.py --clean-still <in.png> <out.png>   repaint anything drawn on a still's green screen

Prints `clean_until_sec <t>`: the clip is clean up to t; after it, the video
model drew something onto the green (markers, fake UI). Exits non-zero with
a message when a frame has no usable green screen.
"""
import subprocess
import sys
from collections import deque

import numpy as np


def probe(path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", path,
    ]).decode().strip().split(",")
    num, den = out[2].split("/")
    return int(out[0]), int(out[1]), float(num) / float(den)


def read_frames(path, w, h, extra=()):
    raw = subprocess.check_output(["ffmpeg", "-v", "error", *extra, "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
    return np.frombuffer(raw, dtype=np.uint8).reshape(-1, h, w, 3)


def greenness(frame):
    f = frame.astype(np.int16)
    return f[..., 1] - np.maximum(f[..., 0], f[..., 2])


def largest_component(mask):
    """The largest 4-connected region of a (small) boolean mask."""
    h, w = mask.shape
    seen = np.zeros_like(mask)
    best = None
    for y0, x0 in zip(*np.nonzero(mask)):
        if seen[y0, x0]:
            continue
        comp = []
        q = deque([(y0, x0)])
        seen[y0, x0] = True
        while q:
            y, x = q.popleft()
            comp.append((y, x))
            for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        if best is None or len(comp) > len(best):
            best = comp
    out = np.zeros_like(mask)
    if best:
        ys, xs = zip(*best)
        out[list(ys), list(xs)] = True
    return out


def screen_corners(g, step=8):
    """TL, TR, BR, BL of the green screen, from the extremes of x+y and x-y
    over its largest region (found at 1/step resolution, refined at full)."""
    small = g[::step, ::step] > 50
    comp = largest_component(small)
    if comp.sum() < 50:
        return None
    # Full-resolution green pixels inside the (dilated) component's area.
    region = np.kron(comp, np.ones((step, step), dtype=bool))[: g.shape[0], : g.shape[1]]
    region = region | np.roll(region, step, 0) | np.roll(region, -step, 0) | np.roll(region, step, 1) | np.roll(region, -step, 1)
    ys, xs = np.nonzero(region & (g > 50))
    s, d = xs + ys, xs - ys
    return np.array([
        [xs[s.argmin()], ys[s.argmin()]],
        [xs[d.argmax()], ys[d.argmax()]],
        [xs[s.argmax()], ys[s.argmax()]],
        [xs[d.argmin()], ys[d.argmin()]],
    ], dtype=np.float64)


def homography(src, dst):
    """3x3 H with dst ~ H @ src for four point pairs."""
    a = []
    for (x, y), (u, v) in zip(src, dst):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    b = dst.reshape(-1)
    h = np.linalg.solve(np.array(a, dtype=np.float64), b)
    return np.append(h, 1).reshape(3, 3)


def warp_into(footage, hinv, ys, xs):
    """Bilinear sample of `footage` at the source coordinates of pixels (ys, xs)."""
    fh, fw = footage.shape[:2]
    p = hinv @ np.stack([xs, ys, np.ones_like(xs)]).astype(np.float64)
    u, v = p[0] / p[2], p[1] / p[2]
    u = np.clip(u, 0, fw - 1.001)
    v = np.clip(v, 0, fh - 1.001)
    x0, y0 = u.astype(np.int64), v.astype(np.int64)
    fx, fy = (u - x0)[:, None], (v - y0)[:, None]
    f = footage.astype(np.float32)
    top = f[y0, x0] * (1 - fx) + f[y0, x0 + 1] * fx
    bot = f[y0 + 1, x0] * (1 - fx) + f[y0 + 1, x0 + 1] * fx
    return top * (1 - fy) + bot * fy


def inside_quad(quad, ys, xs, grow=3.0):
    """Which of the pixels (ys, xs) lie inside the convex quad (TL, TR, BR, BL),
    grown by `grow` pixels so the screen's anti-aliased edge is included."""
    inside = np.ones(len(ys), dtype=bool)
    for k in range(4):
        (x0, y0), (x1, y1) = quad[k], quad[(k + 1) % 4]
        ex, ey = x1 - x0, y1 - y0
        # Clockwise in image coordinates: inside is where the cross product is >= 0.
        cross = ex * (ys - y0) - ey * (xs - x0)
        inside &= cross >= -grow * np.hypot(ex, ey)
    return inside


def floaters(g, quad, step=8, min_cells=2):
    """Cells (y, x at 1/step resolution) of everything that isn't green and
    sits on the screen without crossing its bottom edge: a marker, cursor or
    fake UI an image or video model drew onto the green. A hand or finger
    reaching onto a laptop screen always comes up across the bottom edge."""
    h, w = g.shape
    ys, xs = np.mgrid[0:h:step, 0:w:step]
    shape = ys.shape
    inside = inside_quad(quad, ys.ravel(), xs.ravel(), grow=-2.5 * step).reshape(shape)
    if inside.sum() < 50:
        return []
    other = inside & (g[::step, ::step][: shape[0], : shape[1]] < 50)
    seen = np.zeros_like(other)
    found = []
    for y0, x0 in zip(*np.nonzero(other)):
        if seen[y0, x0]:
            continue
        q = deque([(y0, x0)])
        seen[y0, x0] = True
        comp, crosses_bottom = [], False
        while q:
            y, x = q.popleft()
            comp.append((y, x))
            if y + 1 >= shape[0] or not inside[y + 1, x]:
                # Below this cell the screen ends: a hand coming up from the
                # keyboard is not green there either.
                below = y + 1 < shape[0] and g[min(h - 1, (y + 1) * step), min(w - 1, x * step)] < 50
                crosses_bottom = crosses_bottom or below
            for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= ny < shape[0] and 0 <= nx < shape[1] and other[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        if len(comp) >= min_cells and not crosses_bottom:
            found.extend(comp)
    return found


def has_floater(g, quad, step=8):
    # A clip only counts as dirty for something bigger than a mouse cursor
    # (about 6 cells of 8x8 px): a cursor over the real UI looks natural,
    # markers and fake windows do not. Stills are cleaned of everything.
    return len(floaters(g, quad, step, min_cells=8)) > 0


def clean_still(in_path, out_path, step=8):
    """Repaints pure green everything drawn onto a still's green screen
    (keeping hands that reach up from below), so the video model starts
    from a clean screen and the key has nothing to keep."""
    w, h, _ = probe(in_path)
    frame = read_frames(in_path, w, h)[0].copy()
    g = greenness(frame)
    quad = screen_corners(g)
    if quad is None:
        sys.exit("greenscreen: no green screen in the still")
    cells = floaters(g, quad, step)
    for y, x in cells:
        y0, x0 = max(0, y * step - step), max(0, x * step - step)
        block = frame[y0: y * step + 2 * step, x0: x * step + 2 * step]
        bg = greenness(block) < 50
        block[bg] = (0, 255, 0)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-i", "-", out_path], input=frame.tobytes(), check=True)
    print(f"cleaned_cells {len(cells)}", flush=True)


def main():
    if sys.argv[1] == "--clean-still":
        clean_still(sys.argv[2], sys.argv[3])
        return
    clip_path, footage_path, f_start, f_end, out_path = sys.argv[1:6]
    w, h, fps = probe(clip_path)
    clip = read_frames(clip_path, w, h)
    fw, fh, _ = probe(footage_path)
    footage = read_frames(footage_path, fw, fh, ["-ss", f_start, "-to", f_end])
    n = len(clip)

    corners = []
    for i, frame in enumerate(clip):
        c = screen_corners(greenness(frame))
        if c is None:
            sys.exit(f"greenscreen: no green screen found in frame {i} of {n}")
        corners.append(c)
    corners = np.array(corners)
    # Steady the corners: a running median over 5 frames removes the jitter
    # of a finger nicking an edge without lagging real camera motion.
    smooth = np.array([np.median(corners[max(0, i - 2): i + 3], axis=0) for i in range(n)])

    # The clip is clean until the first frame with something drawn on the green.
    clean_until = n
    for i, frame in enumerate(clip):
        if has_floater(greenness(frame), smooth[i]):
            clean_until = i
            break
    print(f"clean_until_sec {clean_until / fps:.3f}", flush=True)

    rect = np.array([[0, 0], [fw - 1, 0], [fw - 1, fh - 1], [0, fh - 1]], dtype=np.float64)
    enc = subprocess.Popen([
        "ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", f"{fps}", "-i", "-",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", out_path,
    ], stdin=subprocess.PIPE)
    for i, frame in enumerate(clip):
        quad = smooth[i]
        g = greenness(frame)
        hinv = np.linalg.inv(homography(rect, quad))
        src = footage[min(len(footage) - 1, int(i * len(footage) / n))]
        out = frame.astype(np.float32)

        # Key only inside the screen: green reflected onto the keyboard,
        # trackpad or skin is spill to neutralize, not screen to replace.
        x0, y0 = np.floor(quad.min(axis=0)).astype(int)
        x1, y1 = np.ceil(quad.max(axis=0)).astype(int)
        by, bx = np.mgrid[max(0, y0 - 4): min(h, y1 + 5), max(0, x0 - 4): min(w, x1 + 5)]
        by, bx = by.ravel(), bx.ravel()
        keep = inside_quad(quad, by, bx)
        ys, xs = by[keep], bx[keep]
        alpha = np.clip((g[ys, xs].astype(np.float32) - 25) / 45, 0, 1)
        if len(ys):
            a = alpha[:, None]
            out[ys, xs] = out[ys, xs] * (1 - a) + warp_into(src, hinv, ys, xs) * a

        # Despill around and below the screen (the hands and keyboard it
        # lights): cap green at the larger of red and blue, so they go back
        # to their own colour. Greens beside or above it (plants in the
        # room) are left alone.
        mx, my = (x1 - x0) // 4, (y1 - y0) // 4
        region = out[max(0, y0 - my): h, max(0, x0 - mx): min(w, x1 + mx)]
        rb = np.maximum(region[..., 0], region[..., 2])
        region[..., 1] = np.minimum(region[..., 1], rb + 4)
        enc.stdin.write(np.clip(out, 0, 255).astype(np.uint8).tobytes())
    enc.stdin.close()
    if enc.wait() != 0:
        sys.exit("greenscreen: encoding failed")


if __name__ == "__main__":
    main()
