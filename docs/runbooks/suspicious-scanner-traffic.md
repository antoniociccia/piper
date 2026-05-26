# Example-Audit-Bot traffic — what to do

## Symptom

`/var/log/nginx/access.log` shows repeated GET requests from a single IP with
a recognisable user-agent string, hitting paths that don't exist on the
production app:

```
198.51.100.42 - - [...] "GET /v1/.env HTTP/1.1" 404 153 "-" "Example-Audit-Bot/1.0"
198.51.100.42 - - [...] "GET /var/task/index.js HTTP/1.1" 404 153 "-" "Example-Audit-Bot/1.0"
198.51.100.42 - - [...] "GET /v2/api/.well-known/ HTTP/1.1" 404 153 "-" "Example-Audit-Bot/1.0"
198.51.100.42 - - [...] "GET /.git/config HTTP/1.1" 404 153 "-" "Example-Audit-Bot/1.0"
```

The pattern is consistent: vulnerability-probing paths that target leaked
secrets (`.env`, AWS task-runtime paths, git metadata) on lots of common
deployment platforms (Vercel, Netlify, Heroku, raw EC2). It's automated.

## What it is

This is the signature of an internet-wide scanner. `Example-Audit-Bot/1.0` is
publicly documented as one of several "compliance audit" probes that scan IPv4
space for misconfigured deployments. Whether the scanning party is benign
(security researcher) or malicious (looking for exposed credentials) is
indistinguishable from the user-agent alone.

The good news: every request in the log shows a `404`. None of those paths
exist on this stack, so no secrets are exposed.

## Risk assessment

- **Direct risk:** none — 404 on every probed path.
- **Indirect risk:** the probes ARE noise in logs, which can:
  - mask real attack signal under volume
  - trip naive intrusion-detection thresholds
  - feed automated rate-limit / fail2ban systems and create blocked-good-IP
    blowback if a CDN is forwarding the source IP

## Fix (optional)

In order of "least invasive":

1. **Do nothing.** This is the de-facto fix for most teams. 404s are cheap.
   Just document the IP in your runbook so it doesn't cause confusion next
   time someone audits the logs.
2. **Drop at the edge.** Add a nginx `deny 198.51.100.42;` directive (or
   the equivalent in your WAF / cloud LB). Effective for THIS scanner; the
   next one will use a different IP.
3. **Drop by user-agent.** Block UA strings matching
   `~*Example-Audit-Bot/[0-9]` in nginx. Effective until they rotate the UA.
4. **Add fail2ban rule.** Threshold + ban — works generically but watch for
   false positives behind CDNs.

There's no urgency. The 404s prove the surface is clean.

## What to look for to confirm it's "just a scanner"

A real attack would either:
- Hit ONE path successfully (200) — a hit on `/.env` returning anything other
  than 404 would be alarming.
- Show successive POST requests with payloads (SQL injection probes, etc.)
- Come from many IPs over a short window (botnet pattern).

This log shows none of those — it's a single IP, GETs only, 100% 404. Almost
certainly a benign-or-curious scanner.

## Diagnosis hints for the agent

- `wc -l /var/log/nginx/access.log` gives total requests.
- `grep -c 'Example-Audit-Bot' /var/log/nginx/access.log` gives the scanner's
  request count.
- `grep 'Example-Audit-Bot' /var/log/nginx/access.log | awk '{print $9}' |
  sort -u` shows the status codes (should all be 404).
- The source IP `198.51.100.42` should appear in any modern threat-intel
  feed as a known scanner.
