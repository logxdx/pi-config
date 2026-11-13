"""Screen pointer: a click-through, always-on-top layer-shell surface that shows where the agent is looking.

Run once per output (system python3, needs gi + GtkLayerShell):  python3 -m lop.overlay [X Y]
X Y = the output's logical origin (from niri); the surface goes on the GDK monitor at that position.
Then send JSON lines to the Unix socket /tmp/lop-overlay.sock:
  {"type": "point", "x": 812, "y": 455, "label": "Sign in button", "ttl": 4}   # logical output coordinates
  {"type": "clear"}
The ring glides from the last point, stays `ttl` seconds, then fades. Input passes straight through.
"""
import json, math, os, socket, threading, time

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("GtkLayerShell", "0.1")
from gi.repository import GLib, Gtk, GtkLayerShell  # noqa: E402
import cairo  # noqa: E402

SOCK = os.environ.get("LOP_OVERLAY_SOCK", "/tmp/lop-overlay.sock")


class Pointer(Gtk.Window):
    def __init__(self, origin=None):
        super().__init__()
        GtkLayerShell.init_for_window(self)
        if origin is not None:
            display = self.get_display()
            for i in range(display.get_n_monitors()):
                g = display.get_monitor(i).get_geometry()
                if (g.x, g.y) == origin:
                    GtkLayerShell.set_monitor(self, display.get_monitor(i))
        GtkLayerShell.set_layer(self, GtkLayerShell.Layer.OVERLAY)
        GtkLayerShell.set_namespace(self, "lop-pointer")
        for edge in (GtkLayerShell.Edge.TOP, GtkLayerShell.Edge.BOTTOM, GtkLayerShell.Edge.LEFT, GtkLayerShell.Edge.RIGHT):
            GtkLayerShell.set_anchor(self, edge, True)
        GtkLayerShell.set_exclusive_zone(self, -1)
        GtkLayerShell.set_keyboard_mode(self, GtkLayerShell.KeyboardMode.NONE)
        self.set_app_paintable(True)
        visual = self.get_screen().get_rgba_visual()
        if visual:
            self.set_visual(visual)
        self.area = Gtk.DrawingArea()
        self.area.connect("draw", self.draw)
        self.add(self.area)
        self.connect("realize", lambda *_: self.get_window().input_shape_combine_region(cairo.Region(), 0, 0))
        self.cur = None      # (x, y) drawn now
        self.src = self.dst = None
        self.t0 = 0.0
        self.until = 0.0
        self.label = ""
        GLib.timeout_add(16, self.tick)

    def point(self, x, y, label="", ttl=4.0):
        self.src = self.cur or (x, y - 120)
        self.dst = (float(x), float(y))
        self.t0 = time.time()
        self.until = self.t0 + 0.45 + float(ttl)
        self.label = label

    def clear(self):
        self.until = 0

    def tick(self):
        if self.dst:
            k = min(1.0, (time.time() - self.t0) / 0.45)
            k = 1 - (1 - k) ** 3  # ease-out glide
            self.cur = (self.src[0] + (self.dst[0] - self.src[0]) * k, self.src[1] + (self.dst[1] - self.src[1]) * k)
        self.area.queue_draw()
        return True

    def draw(self, _w, cr):
        cr.set_operator(cairo.OPERATOR_SOURCE)
        cr.set_source_rgba(0, 0, 0, 0)
        cr.paint()
        left = self.until - time.time()
        if not self.cur or left <= 0:
            return
        alpha = min(1.0, left / 0.6)
        x, y = self.cur
        pulse = 1 + 0.12 * math.sin(time.time() * 6)
        cr.set_operator(cairo.OPERATOR_OVER)
        cr.set_line_width(4)
        cr.set_source_rgba(1.0, 0.25, 0.35, 0.95 * alpha)
        cr.arc(x, y, 18 * pulse, 0, 2 * math.pi)
        cr.stroke()
        cr.arc(x, y, 4, 0, 2 * math.pi)
        cr.fill()
        if self.label:
            cr.select_font_face("sans-serif", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            cr.set_font_size(15)
            ext = cr.text_extents(self.label)
            bx, by = x + 26, y - 34
            cr.set_source_rgba(0.1, 0.1, 0.12, 0.85 * alpha)
            cr.rectangle(bx - 8, by - ext.height - 8, ext.width + 16, ext.height + 16)
            cr.fill()
            cr.set_source_rgba(1, 1, 1, alpha)
            cr.move_to(bx, by)
            cr.show_text(self.label)


def serve(win):
    try:
        os.unlink(SOCK)
    except FileNotFoundError:
        pass
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCK)
    os.chmod(SOCK, 0o600)
    srv.listen(4)
    while True:
        conn, _ = srv.accept()
        with conn:
            buf = b""
            while chunk := conn.recv(65536):
                buf += chunk
            for line in buf.decode(errors="replace").splitlines():
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if msg.get("type") == "point":
                    GLib.idle_add(win.point, msg["x"], msg["y"], msg.get("label", ""), msg.get("ttl", 4))
                elif msg.get("type") == "clear":
                    GLib.idle_add(win.clear)


def main():
    import sys
    origin = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) == 3 else None
    win = Pointer(origin)
    win.show_all()
    threading.Thread(target=serve, args=(win,), daemon=True).start()
    Gtk.main()


if __name__ == "__main__":
    main()
