# Contributing

An action description must match the implemented effect exactly. In particular, `email()` is deliberately a local letter-writing simulation and must never be described as sent or delivered.

Install dependencies with `npm ci`, run `npm test`, and run `npm run check:release` before opening a change. Tests must not use a live model account, a real recipient, a signed-in social account, or the project's private `data/`, `link/`, or `archive/` directories. Keep new fixtures synthetic and small. If a change alters the prompt, model arrival shape, action surface, memory projection, or scheduling policy, explain that causal intervention in the change description.

Security reports should follow [SECURITY.md](SECURITY.md). By contributing, you agree that your contribution is licensed under the repository's MIT License.
