# Continuity scaffold

This scaffold models functional continuity. It does not establish that a model has phenomenal consciousness or that there is anything it is like to be that model. The distinction follows Thomas Nagel's separation of objective description from subjective character: [What Is It Like to Be a Bat?](https://www.informationphilosopher.com/solutions/philosophers/nagelt/What_its_like.pdf).

## State flow

```text
immutable event record
        |
        | projection; no source row is rewritten
        v
mutable subjective state
identity · memories · beliefs · values · intentions
        |
        | active state plus cue retrieval
        v
living present
last words · returned consequences · incoming events · surroundings
        |
        | model-authored act
        v
real consequence ───────────────> immutable event record
```

The exact API request and response, reasoning fields returned by the provider, emitted text, parsed acts, results, and state transitions remain in an append-only research record. Shelving, revision, consolidation, resolution, and forgetting change the model-facing projection. They do not edit the research record.

## Why these parts exist

William James described thought as personal, changing, continuous, about objects, and selective, rather than as a pile of isolated snapshots ([The Stream of Thought](https://www.yorku.ca/pclassic/James/Principles/prin9.htm)). The tagged state therefore separates continuing background from the current foreground and the immediately retained past.

Work on temporal consciousness distinguishes the just-past that remains present, the current focus, and immediate anticipation ([Stanford Encyclopedia of Philosophy: Temporal Consciousness](https://plato.stanford.edu/archives/spr2020/entries/consciousness-temporal/)). The implementation maps these functions as follows:

| Temporal function | Scaffold state |
| --- | --- |
| Retention of the just-past | `<last>` and `<returned>` |
| Current focus | `<heard>` and `<around>` |
| Immediate anticipation | each intention's `<next>` and `<cue>` |
| Longer autobiographical past | foreground and latent memory |
| Longer future | standing intentions |

Autobiographical memory is reconstructive and is shaped by current goals rather than replayed as a perfect recording ([Conway and Pleydell-Pearce](https://www.researchgate.net/publication/12528554_The_Construction_of_Autobiographical_Memories_in_the_Self-Memory_System)). The framework therefore keeps two deliberately different layers: an exact observer archive and fallible model-authored memory. The same constructive system also supports imagining possible futures ([Schacter, Addis, and Buckner](https://pmc.ncbi.nlm.nih.gov/articles/PMC2429996/)).

Prospective memory research treats intentions as often latent until an event, time, or activity cues them ([McDaniel and Einstein review](https://pmc.ncbi.nlm.nih.gov/articles/PMC4314352/)). An intention therefore carries:

- a goal;
- an observable success condition;
- an optional retrieval cue;
- accumulated evidence;
- a current next step.

`resolve()` immediately removes the intention from the standing set. Its outcome is returned once and the completed intention remains recallable in latent memory. This separation matters because completed intentions can otherwise keep producing commission errors and aftereffects ([Anderson and Einstein](https://pmc.ncbi.nlm.nih.gov/articles/PMC7007322/)).

Human inner experience also is not always verbal. Descriptive Experience Sampling reports inner speaking, imagery, feeling, sensory awareness, and unsymbolized thought, with substantial variation between people ([Heavey and Hurlburt](https://gwern.net/doc/psychology/inner-voice/2008-heavey.pdf)). This runtime cannot observe or store a nonverbal private state from a language model. `think(text)` records only text the model chose to emit; it is not treated as exhaustive evidence about experience.

## Scheduling

Time passing is not itself a state transition. The runtime makes another model call only after one of these facts:

- a prior continuation performed a real act;
- `sleep()` set an explicit return;
- incoming speech arrived;
- a provider error or malformed call requires a factual retry.

If none occurred, the life is idle rather than dead. This removes the former loop in which a timer demanded output, the model verbalized that nothing required action, and that verbalization became the next thing to discuss.

## Boundaries and current limits

- Identity is narrative and self-authored. The runtime supplies no name, personality, mission, belief, value, or motivation.
- Feelings are model-authored reports. No simulated body state is presented as emotion.
- Cue matching is deterministic lexical retrieval, not human semantic memory. Exact cue text or distinctive cue words bring a cued durable memory into foreground.
- Unconsolidated episodes remain visible. This ensures `consolidate()` never folds experiences hidden from the model.
- Tagged state is well-formed XML. Dynamic text is escaped in the prompt, while original bytes remain unchanged in the archive.
- These mechanisms can test persistence, self-report, planning, correction, and autonomous behavior. None is a proof of personhood or phenomenal consciousness.
