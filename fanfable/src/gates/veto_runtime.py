"""Veto runtime: score claimed triples against the sentence that proved them.

Reads a JSON array from stdin, writes a JSON array of {"score": n} or
{"error": "why"}. CPU only: the CUDA path raises a device-side assert.

Run with the bench venv interpreter, which has gliner2 (author branch
feature/relation-verifier @ ff4ae39) and the checkpoint.
"""
import json
import os
import re
import sys

THRESHOLD = float(os.environ.get('FANFABLE_VETO_THRESHOLD', '0.6'))
SPAN_CAP = 510


def locate(text, name):
    i = text.find(name)
    if i >= 0:
        return i, i + len(name)
    low = text.lower()
    i = low.find(name.lower())
    if i >= 0:
        return i, i + len(name)
    toks = [t for t in re.split(r'[^A-Za-z]+', name) if len(t) > 2]
    for tok in ([toks[-1]] if len(toks) > 1 else []) + toks:
        i = low.find(tok.lower())
        if i >= 0:
            return i, i + len(tok)
    return None


def main():
    items = json.load(sys.stdin)
    if not items:
        print('[]')
        return
    from gliner2.verifiers import RelationVerifier
    v = RelationVerifier.from_pretrained('oneryalcin/gliner2-relation-verifier')
    tok = v.tokenizer
    out = []
    for it in items:
        sentence = (it.get('sentence') or '').strip()
        text = (it.get('chunkText') or sentence)[:1200]
        try:
            ids = tok(text, add_special_tokens=False)['input_ids']
            if len(ids) > SPAN_CAP:
                text = tok.decode(ids[:SPAN_CAP], skip_special_tokens=True)
            ha, hb = locate(text, it['fromName']), locate(text, it['toName'])
            if not ha or not hb:
                out.append({'error': 'span-not-found'})
                continue
            _, score = v.verify_single(
                text,
                {'text': text[ha[0]:ha[1]], 'start': ha[0], 'end': ha[1]},
                {'text': text[hb[0]:hb[1]], 'start': hb[0], 'end': hb[1]},
                it['kind'],
            )
            out.append({'score': float(score)})
        except Exception as e:  # noqa: BLE001
            out.append({'error': f'{type(e).__name__}: {str(e)[:120]}'})
    print(json.dumps(out))


if __name__ == '__main__':
    main()
