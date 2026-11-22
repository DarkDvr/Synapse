# Remote access: the LAN switch

The laptop is a **thin client**: the desktop keeps the engine, the projects and every
session; the laptop only needs a browser pointed at the desktop's UI.

## What the switch does

`STATUS → Remote Access` is one boolean, `server.remote`.

- **Off** (default): the listener binds `server.host` (`127.0.0.1`), so nothing on the
  LAN can connect.
- **On**: the listener moves to `0.0.0.0`. The desktop keeps using
  `http://127.0.0.1:8700`; there is no second UI.

It moves in place (`http.relisten`) without restarting the engine. The API answers
before the sockets close, so SSE clients reconnect a moment later and the page
flickers and comes back.

**It is off at every start.** A restart resets `server.remote` to false and the
listener comes up on loopback whatever the file said; measured 29 Oct, a listener
restored as "on" showed on while the LAN still could not reach it. The door is also a
token-protected service, so it should not open itself.

## Who may connect

Three gates, on every request from a non-loopback address:

1. **Remote access is on**, or the request is refused outright.
2. **The address is private:** `10/8`, `172.16/12`, `192.168/16`. A public address is
   refused even with the token.
3. **The token matches.** 32 random bytes in `data/remote-token` (mode 600),
   exchanged once for an `HttpOnly`, `SameSite=Strict` cookie by `/login?token=…`. It
   never appears in a page, and `/api/remote` returns it **only to loopback**.

The login page is self-contained because it loads before there is a cookie. The
engine's port (8720) is never exposed: the server proxies every engine call.

## Using it

1. On the desktop, with the server up: STATUS → Remote Access → on.
2. A line appears with the desktop's name, `http://<machine-name>:8700/`, and a count
   (`clients: 1`) whose tooltip names them. A name arrives from a reverse lookup
   after the connection; a client the network cannot name is never printed as an
   address.
3. The **TOKEN** chip copies it; paste it into the login page. The cookie signs in
   once.
4. If the desktop's IP changes, the address changes; the token stays valid.
5. **Countdowns follow the desktop's clock.** Every response's `Date` header becomes
   an offset (`state.clockSkew`), so a laptop minutes off counts from the same start.

Allow the firewall prompt on **Private** networks only. Do not port-forward 8700; for
access outside the house use a private overlay such as Tailscale. The desktop must
stay awake — Windows sleep stops it even with the window in the tray.

## What it is not

- **Not HTTPS.** On a trusted LAN the token keeps other devices out, not a passive
  sniffer.
- **Not multi-user.** Everyone who opens the link is the operator and can answer
  cards, stop runs and change settings. Treat the address and token as a password.
- **Not a second copy of the app.** The desktop serves the UI, so both machines run
  the same code.
