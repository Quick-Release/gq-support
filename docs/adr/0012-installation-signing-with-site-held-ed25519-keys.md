---
status: accepted
---

# Installations sign with site-held Ed25519 keys

Each WordPress installation signs its requests to the support service with an Ed25519 private key it generates itself. It sends only the public key when it enrolls, using a single-use operator enrollment code. The service stores public keys, never a shared secret. We chose this over the per-installation HMAC key first proposed in the security design. With HMAC, the secret has to be issued and returned to the site at least once, and the service must hold it encrypted under a master key, so a leak of the service database plus that key could forge requests from every installation. With Ed25519, the private key never leaves the site or passes through a person, and a service-side leak exposes nothing that can sign. The costs are slightly heavier signing code (WordPress core's `sodium_compat` on PHP, WebCrypto Ed25519 in Workers) and no key recovery: a lost key means re-enrolling with a new code. The canonical signed string, timestamp window and replay rules are unchanged, and #32 still owns their exact definition. Rotation is re-enrollment only. A site cannot rotate its own key, so a stolen key cannot be used to lock out the real site.
