# Donna

**An autonomous dispatcher for food-bank donations.**

Food comes in through any channel → an AI agent structures it → a transparent
scoring engine matches each item to the fairest capable recipient using
persistent memory → voice agents make the calls → the donor always hears back →
the manager tunes it all by chatting.

Built for the AI Supply Chain Hackathon.

## The idea in one line
**AI at the edges, deterministic fairness math in the middle** — so allocation is
fast *and* explainable *and* provably equitable over time.

## Stack
- **VAPI** — real-time voice calls (inbound intake + outbound offers)
- **InsForge** — backend, database, and agent brains (OpenRouter-backed AI)
- **Deterministic scoring engine** — the auditable core that picks recipients

## The agents
1. **Intake Parser** — any channel → structured, multi-item donation
2. **Offer Drafter** — writes the pitch / call script
3. **Recipient Caller** — voice-calls pantries *and* community-agency leads
4. **Manager Copilot** — manager tunes the system by chatting
5. **Donor Callback** — itemized "here's what we could and couldn't take"

Plus a deterministic **Scoring Engine** (feasibility · cold-chain · capacity ·
equity · preferences) and **persistent recipient memory** that learns from every
call.

## → Full spec: [PRD.md](PRD.md)
