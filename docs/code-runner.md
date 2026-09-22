# Setting up a code runner

Online SVS runs Python, JavaScript and TypeScript inside your browser. Everything else — C,
C++, C#, Java, Go, Rust, PHP, Ruby, Kotlin, Swift, Bash and Lua — has to be compiled, which a
browser cannot do. Those go to a [Piston](https://github.com/engineer-man/piston) server that
you run.

This guide sets one up on a free Oracle Cloud machine so that **anyone opening your site gets a
working Run button**, with nothing to install and no permission prompts.

If you only want it working for yourself, skip to [Just for you](#just-for-you) at the end — it
is ten minutes instead of an hour.

---

## Read this first: not the ARM machine

Oracle's headline free offer is an **Ampere A1 (ARM)** machine. **Piston will not run on it.**

- The `ghcr.io/engineer-man/piston` image publishes a single-architecture manifest, not a
  multi-architecture index.
- Piston's language packages — the actual compilers — are built by a workflow that runs only on
  `ubuntu-latest`, which is x86-64. There is no ARM build of them.

So a beginner-sized C++ program would not merely be slow on ARM; nothing would run at all, and
the error (`exec format error`) does not explain itself. Pick the **AMD** shape instead:

| Oracle Always Free shape | Architecture | Free allowance | Piston |
|---|---|---|---|
| Ampere A1 (ARM) | arm64 | 2 cores, 12 GB | ✗ will not run |
| **VM.Standard.E2.1.Micro (AMD)** | **x86-64** | **1/8 OCPU, 1 GB RAM, ×2** | ✓ |

1/8 of a core sounds hopeless, but it is *burstable* — it borrows a full core for short spikes,
which is exactly the shape of a compile. 1 GB of RAM is the real constraint, and step 5 below
sets the limits that keep it from falling over.

---

## 1. Create the machine

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com). A card is needed to verify you; the
   Always Free resources are not billed.
2. **Compute → Instances → Create instance**.
3. Under **Image and shape → Change shape**, pick **Ampere… no.** Choose **AMD**, then
   **VM.Standard.E2.1.Micro**. It should be labelled *Always Free eligible*.
4. Image: **Ubuntu 22.04** (or 24.04).
5. Under **Add SSH keys**, let it generate a key pair and **download the private key** — you
   cannot get it again.
6. Create, and note the **public IP address**.

## 2. Open the ports — in both places

This is where most people get stuck. Oracle blocks inbound traffic in *two* independent layers,
and opening only one leaves you with a machine that times out silently.

**Layer one, in the Oracle console:** Instance → Subnet → Default Security List → *Add Ingress
Rules*. Add two, both with Source `0.0.0.0/0`, IP Protocol `TCP`:

| Destination port | What for |
|---|---|
| 80 | Let's Encrypt has to reach you to issue the certificate |
| 443 | HTTPS, the address your site will actually call |

Do **not** open 2000. Piston should never be reachable from outside; Caddy talks to it locally.

**Layer two, on the machine itself.** Ubuntu images from Oracle ship iptables rules that drop
almost everything:

```sh
ssh -i your-key.key ubuntu@YOUR_IP

sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 3. Install Docker

```sh
sudo apt update && sudo apt install -y docker.io
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
exec su -l $USER          # pick up the new group without logging out
```

## 4. Start Piston

`--privileged` is not optional: Piston isolates each program in its own sandbox, and that needs
kernel features a normal container cannot reach.

```sh
docker run -d \
  --name piston_api \
  --privileged \
  --restart unless-stopped \
  -p 127.0.0.1:2000:2000 \
  -v /var/piston:/piston \
  -e PISTON_MAX_CONCURRENT_JOBS=2 \
  -e PISTON_COMPILE_MEMORY_LIMIT=400000000 \
  -e PISTON_RUN_MEMORY_LIMIT=200000000 \
  -e PISTON_COMPILE_TIMEOUT=15000 \
  -e PISTON_RUN_TIMEOUT=5000 \
  ghcr.io/engineer-man/piston
```

Those five environment variables matter more than they look, because **Piston's own defaults
will kill a 1 GB machine**:

| Setting | Piston's default | Here | Why |
|---|---|---|---|
| `MAX_CONCURRENT_JOBS` | 64 | 2 | 64 simultaneous compiles on 1 GB is an instant out-of-memory |
| `COMPILE_MEMORY_LIMIT` | `-1` (unlimited) | 400 MB | one runaway compile could otherwise take the whole machine down |
| `RUN_MEMORY_LIMIT` | `-1` (unlimited) | 200 MB | same, for the program itself |
| `COMPILE_TIMEOUT` | 10 s | 15 s | a burstable eighth of a core is slower than a laptop |
| `RUN_TIMEOUT` | 3 s | 5 s | same |

Note `-p 127.0.0.1:2000:2000` — binding to loopback means Piston is reachable only from the
machine itself, never from the internet directly.

## 5. Install the languages

Piston starts empty. Install what you want over its own API:

```sh
install() { curl -s -X POST http://localhost:2000/api/v2/packages \
  -H 'Content-Type: application/json' -d "{\"language\":\"$1\",\"version\":\"$2\"}"; echo; }

install gcc 10.2.0          # C, C++ (and D, Fortran)
install java 15.0.2
install mono 6.12.0         # C#
install go 1.16.2
install rust 1.68.2
install python 3.12.0       # only needed if someone wants it server-side
install bash 5.2.0
install lua 5.4.4
```

Each one is a download of a real compiler, so give them a minute. Check what took:

```sh
curl -s http://localhost:2000/api/v2/runtimes | head -c 400
```

Be a little sparing — every package eats disk and the free block volume is 200 GB shared across
your instances.

## 6. A domain, HTTPS and CORS

Three things have to be true before a browser will talk to your runner:

1. **It must be HTTPS.** Your site is HTTPS, and a page cannot call a plain-HTTP address.
2. **It needs a domain**, because certificates are issued for names, not IP addresses.
3. **It must send CORS headers.** Piston sends none at all — it registers no CORS middleware —
   so without this the browser refuses every request before Piston sees it.

Caddy does all three. For a free domain, [DuckDNS](https://www.duckdns.org) gives you
`something.duckdns.org` pointed at your IP in about a minute.

```sh
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Then `sudo nano /etc/caddy/Caddyfile`, replacing everything with:

```
yourname.duckdns.org {
	header {
		Access-Control-Allow-Origin "https://jari101.github.io"
		Access-Control-Allow-Methods "GET, POST, OPTIONS"
		Access-Control-Allow-Headers "Content-Type, Authorization"
		Access-Control-Max-Age "86400"
	}

	@preflight method OPTIONS
	respond @preflight 204

	reverse_proxy localhost:2000
}
```

```sh
sudo systemctl restart caddy
```

Caddy fetches a certificate by itself on first start. Put your own site's address in
`Access-Control-Allow-Origin` — `*` would let any page on the internet use your runner from a
browser.

## 7. Point Online SVS at it

Open your site, **Settings → Code runner**, and enter:

```
https://yourname.duckdns.org/api/v2
```

Leave **Key** empty — that field is only for a public Piston that whitelisted you. Press
**Test connection**. It should say how many languages it found.

Every visitor now gets a working Run button for the compiled languages, with nothing to install.

---

## Before you leave it running

A code runner on the public internet will run **anybody's** code, not just your visitors'. The
URL is in your site's settings, so treat it as public.

Piston sandboxes every program and the limits in step 4 cap what one job can take, so this is
not as alarming as it sounds — but it is your machine and your bandwidth. Worth doing:

- Keep `Access-Control-Allow-Origin` pinned to your site. It does not stop `curl`, but it stops
  every other website using your runner from a browser.
- Check in occasionally: `docker stats piston_api` and `df -h`.
- If it gets abused, the quickest fix is changing the DuckDNS subdomain.

## If 1 GB turns out to be too tight

Symptoms are compiles that fail with no message, or the machine going unresponsive. Options, in
order of effort:

1. Add swap — often enough on its own:
   `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`
   (and add it to `/etc/fstab` to survive a reboot)
2. Drop `PISTON_MAX_CONCURRENT_JOBS` to 1.
3. Move to a paid x86 VPS. Hetzner's smallest is around €4/month for 2 vCPU and 4 GB, and every
   command in this guide works unchanged.

## Just for you

If nobody else needs a Run button, skip all of the above:

```sh
docker run -d --name piston_api --privileged -p 2000:2000 -v /var/piston:/piston \
  ghcr.io/engineer-man/piston
```

Install languages as in step 5. You still need CORS, so put Caddy in front locally with a
`Caddyfile` of:

```
:2001 {
	header Access-Control-Allow-Origin "*"
	@preflight method OPTIONS
	respond @preflight 204
	reverse_proxy localhost:2000
}
```

and point Settings at `http://localhost:2001/api/v2`.

One catch: **serve Online SVS locally too** — `python3 -m http.server 8000` in the project
folder, then open `http://localhost:8000`. A site on the public internet reaching anything on
your own machine is
[behind a permission prompt from Chrome 142](https://developer.chrome.com/blog/local-network-access),
and a page served locally is on the same side of that line. `localhost` means *the computer the
browser is on*, so this arrangement serves you and nobody else.

## When something does not work

| What you see | Usually |
|---|---|
| Test connection: "Could not reach it" | Ports not open in **both** places — the Oracle Security List *and* iptables (step 2) |
| Browser console mentions CORS | Caddy is not in front, or the Caddyfile's origin does not match your site exactly |
| `exec format error` in `docker logs` | The ARM machine. Rebuild on the AMD shape |
| "does not offer C++" | The package is not installed — step 5, `gcc` provides C and C++ |
| Compile works locally, times out here | Raise `PISTON_COMPILE_TIMEOUT`; an eighth of a core is slow to start |
| Certificate never issued | Port 80 closed, or DuckDNS not yet pointing at the IP |

---

*The Piston facts here — the single-architecture image, the x86-only package builds, the missing
CORS middleware, and the default limits — were checked against its source. The Oracle steps are
written from its published free-tier terms and have not been run end to end, so if a screen has
moved, trust the console over this page.*
