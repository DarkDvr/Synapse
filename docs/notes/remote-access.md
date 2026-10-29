# Remote access: the LAN switch

The operator leaves the desktop running and opens Synapse from a laptop on the
same network. The laptop is a **thin client**: the desktop keeps the engine, the
projects and every session; the laptop only needs a browser pointed at the
desktop's UI.

## What the switch does

`STATUS → Remote Access` is one boolean, `server.remote` in the config file.

- **Off** (default): the HTTP listener binds `server.host` (`127.0.0.1`). Nothing
  on the LAN can connect, because nothing is listening there.
- **On**: the listener moves to `0.0.0.0` so a private IPv4 address can reach it.
  The desktop keeps using `http://127.0.0.1:8700`; there is no second UI.

The listener moves in place (`http.relisten`), without restarting the engine. The
API answers the toggle before the sockets close; SSE clients reconnect a moment
later — that is why the page flickers and comes back.

**It is off at every start.** A restart resets `server.remote` to false and the
listener comes up on loopback, whatever the file said before. Measured 29 Oct: a
listener restored as "on" at boot showed on while the LAN still could not reach
it, and only toggling off and on actually opened it. The door is also a token-
protected service, so it should not open itself. Turn it on from the desktop
after the server is up; the token is unchanged.

## Who may connect

Three gates, checked on every request from a non-loopback address:

1. **Remote access is on.** If it is off, a non-loopback request is refused
   outright (in practice the port is not listening either).
2. **The address is private:** `10/8`, `172.16/12` or `192.168/16`. A public
   address is refused even with the token.
3. **The token matches.** The token is 32 random bytes, written to
   `data/remote-token` (mode 600), and exchanged once for an `HttpOnly`,
   `SameSite=Strict` cookie by `/login?token=…`. The token itself never appears in
   a page, and `/api/remote` returns it **only to loopback** — a LAN client gets
   `token: null` and types it into the login page.

The login page is self-contained (no assets) because it has to load before the
browser has a cookie.

The engine's own port (8720) is never exposed: the Synapse server proxies every
engine call. Exposing 8720 would put the engine's API, and its session data, on
the network.

## Using it

1. On the desktop, with the server up: STATUS → Remote Access → on.
2. A second line appears under the switch with `http://<lan-ip>:8700/`. Open it on
   the laptop.
3. The **TOKEN** chip on that line copies the token; paste it into the login
   page. The cookie signs in once; the address then opens straight to the UI.
4. If the desktop's IP changes, the address changes; the token stays valid.
5. Off hides the address and the chip entirely: one row, nothing on the LAN.

Windows Firewall may ask for permission the first time the listener goes public;
allow it on **Private** networks only. Do not port-forward 8700; if you need
access outside the house, use a private overlay network such as Tailscale, not a
public port.

The desktop must stay awake; the tray app can serve with the window closed, but
Windows sleep will still stop it. Set sleep to never while plugged in, or use a
power plan for it.

## What it is not

- Not HTTPS. On a trusted home LAN the token is protected from other devices but
  not from a passive sniffer on the same network. HTTPS with a self-signed cert is
  the later upgrade if the LAN is not trusted.
- Not multi-user. Everyone who opens the link is the operator: they can answer
  permission cards, stop runs and change settings. Treat the address and token as
  a password.
- Not a second copy of the app. The desktop serves the UI, so both machines run
  the same code with no version skew. A remote mode in `Synapse.exe` (skip the
  local server, load the remote URL) is a later shell feature, not required for
  this.
