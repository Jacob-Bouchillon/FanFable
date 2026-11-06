# GLiNER — architecture notes for FanFable

Source: <https://urchade.github.io/GLiNER/architectures.html> (docs read 2026-11-06).

GLiNER is a framework for training and deploying zero-shot NER and relation extraction on
BERT-like encoders. The part that matters is that labels are supplied at inference time, so the
model can be asked for our kinds instead of a fixed inventory.

## Variants

| Architecture | Encoding | Prediction | Best for |
|---|---|---|---|
| `UniEncoderSpan` | one encoder, text + labels | span | general NER, <30 types |
| `UniEncoderToken` | one encoder | token (BIO) | long entities, summaries |
| `BiEncoderSpan` / `BiEncoderToken` | separate text and label encoders | span / token | 50–200+ types, cached label vectors |
| `UniEncoderSpanDecoder` | encoder + generative decoder | span + generated label | open-vocabulary labels |
| `UniEncoderTokenDecoder` | token + decoder | token + generated label | long entities, open vocabulary |
| **`UniEncoderSpanRelex`** | encoder + relation layers | span + relations | **joint entity + relation, KG building** |
| `UniEncoderTokenRelex` | token + relation layers | token + relations | long entities with relations |
| `StreamingSpan` | causal decoder, KV cache | span, rolling rescoring | incremental / live text |

The docs' own decision table: knowledge-graph extraction → `UniEncoderSpanRelex`; incremental
input → `StreamingSpan`.

## What we would use

1. **`UniEncoderSpanRelex` now** (`knowledgator/gliner-relex-large-v0.5`, 0.5B, Apache-2.0).
   Joint entity + relation in one forward pass; spans carry character offsets, so the cited quote
   is the sentence that contains them.
2. **`StreamingSpan` later** for incremental ingestion — append a new chapter to a causal KV
   cache and re-score recent spans, instead of re-extracting the book.
3. **`BiEncoderSpan`** if the kind list grows past ~30. It pre-computes label embeddings, which
   also makes a fixed schema cheap to serve.

## What the framework adds beyond a checkpoint

- **Training:** `gliner.training` with span, adjacency and relation losses, focal loss and label
  smoothing. Once the worker and judge produce quote-backed rows, they become training data.
- **Runtime:** ONNX and OpenVINO export, plus a serving module. A small ONNX encoder on CPU
  avoids shipping PyTorch as the default path.
- **Evaluation:** `gliner.evaluation` reports precision/recall/F1 — the metric our alias layer
  has been missing.

## Output shape

```python
entities, relations = model.inference(
    texts=[text],
    labels=entity_labels,
    relations=relation_labels,
    threshold=0.5,
    adjacency_threshold=0.6,
    relation_threshold=0.8,
)
```

```json
{"head": {"start": 0, "end": 10, "text": "John Smith", "type": "person", "entity_idx": 0},
 "tail": {"start": 20, "end": 29, "text": "Microsoft", "type": "organization", "entity_idx": 1},
 "relation": "works_at", "score": 0.87}
```

## Spike plan and bar

Run `gliner-relex-large-v0.5` over three HP1 windows with our label schema and thresholds
(entities 0.3–0.5, adjacency 0.5–0.65, relations 0.7–0.9). Score:

- entity recall and kind agreement against the baseline bank (264 entities, 89 characters);
- false persons on known non-people (Gringotts, Great Hall, the Stone);
- **verified keepers per 10 relation proposals** after the case-file judge.

Adopt only at roughly one keeper per ten proposals and under a minute per window on CPU. Kill it
if the relations are mostly co-occurrence/`acquaintance`. No model adjudicates: proposals go
through the gate.
