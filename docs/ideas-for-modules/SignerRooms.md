# Signer Rooms (idea, off-chain, no contracts needed)

p2p "meeting space" in the app where wallets meet to talk and co-sign agreements / financial decisions.
Side project to the protocol, mostly cryptography + app. No onchain tx, no events.

Related: /Users/frankencoin/Documents/wrytes/evm-payment-channels (bilateral channels with EIP-712 co-signed states + nonces).
A room is the same model, but with messages and agreements instead of balances.

## Goals

- no onchain tx/events
- connected wallet as identity, plus synthetic keys derived from it for encryption (AES)
- p2p, decentralized
- data availability: not solved yet (see below)

## Keys

- wallet signs one fixed EIP-712 message -> HKDF -> x25519 messaging keypair + session signing key
- wallet signs a binding once: "session key X acts for address Y until T" (one popup per session, not per message)
- never use the wallet key itself for encryption
- caveat: only works with EOAs (deterministic RFC6979 signatures). Safe / ERC-1271 wallets can't derive a stable key -> random local key instead

## Encryption

- small rooms (<= ~10): random room key, AES-GCM (WebCrypto), wrapped per member to their x25519 key (HPKE)
- member removed -> rotate room key
- bigger rooms / forward secrecy: MLS (ts-mls), not for the MVP
- invite link = room key in the URL fragment

## Message log

- envelope: { room, author, seq, prevHash, ciphertext, sig }
- hash-chained, so any peer can verify and sync from any other peer (exchange heads)

## Agreements (the point of the whole thing)

- Agreement { roomId, docHash, parties, deadline, nonce }, signed by all parties via EIP-712
- signature bundle = portable proof, verifiable offchain or onchain by anyone (ecrecover / ERC-1271)
- can be the payment channel structs (Funding / Balance): room = place to co-sign channel states before anything hits the chain

## Transport

| option | note |
|---|---|
| Waku (light client + Store) | built for dapps, RLN spam protection, Store nodes = basic DA. Preferred. |
| libp2p (WebRTC, GossipSub, circuit relay v2) | purist p2p, no DA |
| Trystero (WebRTC mesh, signaling via Nostr/BitTorrent) | fastest prototype, no own servers, no DA |

## Data availability (open)

- rooms are ephemeral by design
- every participant keeps their own copy of the log, signed agreements are what persists
- offline catch-up via Waku Store
- later: export encrypted log to IPFS / Codex, pay for pinning via payment channels

## Anonymity

- binding agreements need non-repudiation = identity bound to an address, opposite of anonymity
- phase 1: identity-bound rooms
- phase 2 (optional): anonymous mode with Semaphore / RLN proofs, chat only, no agreements

## MVP

1. wallet-derived keys, room + invite link, signed hash-chained log
2. Waku light client + Store for catch-up
3. propose / sign agreement flow with exportable signature bundle

App side: dashboard subpage, logic inline (dashboard page pattern), crypto + transport in a plain lib module.

## Open questions

- Waku vs Trystero first?
- who may open / join rooms: anyone, sUSDU holders, protocol signers?
- does a signed agreement need an onchain anchor option (e.g. via channel settlement), or stay purely offchain?
