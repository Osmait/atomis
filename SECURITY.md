# Security

## What Atomis is

Atomis compiles and runs code you give it, on the machine it runs on. That is
the product, not a flaw — but it means **anything that can reach the port can
run code as the user the server runs as**. Read that sentence again before
putting it on a network.

## The defaults

The server listens on `127.0.0.1` and nothing else. On that address only
processes on the same machine can reach it, which is the single-user desktop
case Atomis is built for.

Setting `ATOMIS_HOST` to anything wider requires `ATOMIS_TOKEN`. The server
refuses to start otherwise, before it binds, so an open port never exists.
A warning would have been read after the fact, if at all.

```bash
ATOMIS_TOKEN=$(openssl rand -hex 24) ATOMIS_HOST=0.0.0.0 pnpm start
```

Every API call and both WebSockets then need that secret — `Authorization:
Bearer …`, or `?t=…` for the sockets, which cannot send headers. The page
takes it from `…/?t=<token>` once and keeps it per device.

A second, older guard is still there: requests must come from an origin the
server trusts — its own loopback URL, plus whatever `ATOMIS_ALLOWED_ORIGINS`
lists. It stops a page on some other site from driving your server through
your browser. It is not a substitute for the token, because an origin is a
name rather than a secret, and only the token survives a client that is not a
browser.

## What the sandbox does and does not do

On Linux 6.7+ with Landlock, every process a session spawns is confined to its
own workspace and refused TCP. `pnpm run doctor` reports what your kernel
actually enforces. Everywhere else — macOS, older kernels, or with the toggle
off — **your code runs with your permissions**.

The sandbox confines the code you run. It does not confine the server: the
server reads and writes its workspaces, spawns compilers, and on the
dependency path reaches the network.

A token is not a sandbox either. It decides who gets to run code, not what
that code may do.

## What inline values and test results are

The instrumentation channels — the `\x1e…\x1f` markers on stdout/stderr and
the NDJSON on fd 3 — travel in-band with the program's own output, so a
program can print a well-formed marker and forge an inline value or a test
result. This cannot be prevented from inside the process: code that could
forge a "passed" could as easily make the test pass. It matters exactly
once: in a shared workspace, results shown for a collaborator's code are
claims made by that code. Treat them accordingly.

## Reporting

Open an issue for anything that lets one session read or write outside its
workspace, escape the Landlock policy, or bypass the token when one is set.
Please do not include a working exploit in a public issue — describe the
class of problem and how to reproduce it, and we will take it from there.
