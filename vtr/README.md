# Verifiable Trust Receipt (VTR)

A Verifiable Trust Receipt is a signed statement that one evaluation against a Trust Requirements Profile happened and what it found. Anyone can check one without trusting the party that issued it, and anyone who has the evidence can run the evaluation again and get the same answer. `spec.md` is the specification.

| File | Purpose |
|---|---|
| `spec.md` | VTR version 0.5 |
| `schema/vtr.schema.json` | The claims as JSON Schema |
| `tools/vtr.py` | Reference library for claims, signing, verification and batches |
| `tools/vtr_emit.py` | Evaluates evidence against a profile and prints a signed receipt |
| `tools/vtr_verify.py` | Python verifier |
| `tools/vtr_verify.js` | Node.js verifier, written apart from the Python one |
| `tools/make_vectors.py` | Writes the test vectors |
| `vectors/` | 27 valid and 18 invalid receipts with their profiles, evidence and test keys |

## Use

```bash
pip install cryptography
python vtr/tools/vtr_emit.py --new-key es256 > issuer.pem
python vtr/tools/vtr_emit.py --jwks issuer.pem > jwks.json
python vtr/tools/vtr_emit.py --profile examples/manufacturing-safety/trp.json --evidence evidence.json \
  --key issuer.pem --iss https://evaluator.example.com --sub urn:example:cell:01 > receipt.jws
python vtr/tools/vtr_verify.py receipt.jws --jwks jwks.json --profile examples/manufacturing-safety/trp.json --evidence evidence.json
node vtr/tools/vtr_verify.js receipt.jws --jwks jwks.json --profile examples/manufacturing-safety/trp.json --evidence evidence.json
```

The TRP gate in `adapters/gate` signs a receipt for every tool call and tool result it judges. Pass `--receipts receipts.jws --receipt-key issuer.pem` to the MCP checkpoint, or `receipts=` and `receipt_key=` to `make_gate` in `adapters/frameworks`.

## Checks

`python tests/vtr_check.py` runs both verifiers over every vector and confirms they agree. It confirms both derive the same standing and result digest for every conformance profile and evidence sample, and it checks receipts the gate signs along with Merkle inclusion proofs for every leaf of trees of 1 to 33 receipts.
