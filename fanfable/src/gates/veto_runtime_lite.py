"""Veto runtime on vela3-lite (GPU).

Reads a JSON array of claimed triples from stdin and writes one probability per
row: p(the text states this). The adopted veto threshold is 0.60.

GPU only. One resident at a time: the caller stops Ollama before this runs.
"""
import json
import os
import sys

FAMILIES = ['parent_of', 'child_of', 'master_of', 'ally_of', 'enemy_of', 'member_of',
            'servant_of', 'spouse_of', 'sibling_of', 'debtor_of', 'employer_of', 'located_in']
MODEL = os.environ.get('FANFABLE_VETO_MODEL', 'vllm-sr/vela3-lite')

SYSTEM = (
    'You are a relation extraction system. Be concise and direct. '
    'Output ONLY the relation type that holds between the two mentioned entities, '
    'or NONE when the text states no relation between them. '
    'Do not output any explanation, punctuation, or extra text.'
)


def load():
    import torch
    from transformers import AutoModel
    m = AutoModel.from_pretrained(MODEL, trust_remote_code=True)
    if not torch.cuda.is_available():
        raise RuntimeError('vela3-lite veto requires CUDA; CPU is retired')
    return m.to('cuda')


def main():
    items = json.load(sys.stdin)
    if not items:
        print('[]')
        return
    m = load()
    out = []
    for it in items:
        text = (it.get('chunkText') or it.get('sentence') or '')[:1400]
        claim = f"The text states that {it['fromName']} is {it['kind']} {it['toName']}."
        try:
            res = m.system_one(state=text, questions={
                'claim': {'type': 'noul', 'instructions': claim},
            })
            answer = res['answers']['claim']
            score = answer.get('noul') if isinstance(answer, dict) else None
            if score is None:
                out.append({'error': 'unexpected-answer'})
            else:
                # The veto asks "does the text support this claim"; the noul
                # head answers yes with this probability.
                out.append({'score': float(score)})
        except Exception as e:  # noqa: BLE001
            out.append({'error': f'{type(e).__name__}: {str(e)[:120]}'})
    print(json.dumps(out))


if __name__ == '__main__':
    main()
