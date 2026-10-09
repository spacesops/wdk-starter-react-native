# Opinion: CFTC Staff Letter 26-09 and Spaces Wallet

**Source reviewed:** `cftc_staff_letter.txt` (transcription of CFTC Letter No. 26-09, Market Participants Division, March 17, 2026)

**Project reviewed:** Spaces Wallet (`wdk-starter-react-native-spaces-wallet`) — a non-custodial multi-chain crypto wallet with Bitcoin Spaces protocol integration.

**Date of this opinion:** September 21, 2026

This is not legal advice. A CFTC/commodities lawyer should read the official PDF on cftc.gov together with the actual product. The local text file has transcription gaps; the signed letter is the source of truth.

---

## Short answer

This project is not inside Letter 26-09’s protected activity, and you cannot “comply” with that letter the way you would with a statute or a general safe harbor. The letter is a **Phantom-only staff no-action** for a **CFTC-regulated derivatives front end**. Spaces Wallet, as it exists today, is a **self-custodial spot wallet** plus Spaces name purchases. Those are much closer to Phantom’s *existing* wallet than to the activity the CFTC staff actually blessed.

---

## What the letter actually covers

CFTC Staff Letter 26-09 (March 17, 2026) is from the Market Participants Division to **Phantom Technologies, Inc.** Phantom asked staff not to recommend IB registration under CEA § 4d(g), or AP registration under § 4k, **solely because of “Proposed Activities.”**

Those Proposed Activities are not “being a crypto wallet.” They are:

- a front end for **Commission-regulated derivatives** (event contracts, perpetuals, other listed products)
- orders sent to **Collaborators**: a DCM, or a registered FCM/IB
- possible **revenue share** with those Collaborators and/or **transaction-based fees** on users
- **marketing** specific contracts and **introducing users** to specific Collaborators
- a **custodial derivatives** model: margin/collateral at a DCO or FCM, not in Phantom’s wallet

Staff granted that only with **ten conditions**, including:

1. Statutory-disqualification screening of Phantom, principals, and soliciting individuals
2. Disclosures of Phantom’s relationship with Collaborators and potential conflicts of interest
3. A risk disclosure addressing risks covered by 17 CFR 1.55(b), unless a registered Collaborator already must provide one
4. Users onboarded as DCM members or FCM/IB customers, with independent access to the Collaborator
5. Policies reasonably designed to comply with Commission and NFA public-communications rules as if Phantom were an IB
6. No advertising that would require NFA pre-approval under NFA Compliance Rule 2-29
7. Written joint-and-several undertakings with each Collaborator, filed with the Division, consenting to Commission jurisdiction
8. Records of Commission-regulated activity consistent with Regulation 1.31
9. Notice to the Division of insolvency or bankruptcy
10. A filed notice agreeing to the conditions and consenting to Commission jurisdiction

The letter also says, in substance:

- it binds **only MPD**, not the Commission
- it is based on **Phantom’s facts**
- different or omitted facts can make the position **void**
- it lasts until Commission rulemaking/guidance on software IB registration

So it is not a general license for “self-custodial wallets,” and it is not a checklist another issuer can satisfy and then claim the same relief.

---

## What this project actually is

Spaces Wallet is a non-custodial multi-chain wallet: seed generation/import, send/receive, balances, Bitcoin Spaces namespace purchases. Supported assets are spot instruments (BTC, USD₮, XAU₮, USA₮) on Bitcoin, EVM chains, TON, Tron, Solana, and Lightning.

There is no DCM/FCM/IB integration, no listed futures/options/event-contract order ticket, no collaborator revenue share for derivatives, and no user onboarding onto a CFTC intermediary.

That maps to the letter’s **background** description of Phantom’s *current* wallet (“akin to a password manager… self-directed crypto asset transactions”), not to the Proposed Activities that triggered IB concern.

Staff did **not** grant no-action for that existing wallet. They treated the existing wallet as already outside the IB question, and granted relief only because the **new derivatives UI** would otherwise be IB activity and would **not** fit the older TSV letters (06-29, 08-07, 08-12).

---

## Opinion on “compliance”

| Question | Opinion |
|---|---|
| Does Letter 26-09 apply to this repo / this issuer? | **No.** It is addressed to Phantom, on Phantom’s facts. Third parties generally cannot rely on another firm’s no-action letter. |
| Can you put the ten conditions in the app and be “in scope”? | **No.** Those conditions are the *price of Phantom’s relief* for derivatives order routing. Meeting them without MPD’s letter does not give you Phantom’s protection. |
| Does the current product look like Phantom’s Proposed Activities? | **No.** There is no CFTC-regulated derivatives trading surface. |
| Does the current product look like activity that *needed* this letter? | **Probably not**, on the letter’s own theory: IB status is about soliciting/accepting orders in futures and similar products, not about self-directed spot transfers or buying a Spaces name with BTC. |
| Would this letter be useful later? | **As precedent only.** If you later add Kalshi/CME-style event contracts, perps on a DCM, or a similar Collaborator UI, this is the map of what staff cared about. You would still need your own request, registration, or later Commission rules. |

Two extra mismatches if someone tried to stretch the analogy:

1. **Custody model.** The letter’s derivatives flow is custodial at a DCO/FCM. This wallet is non-custodial for user keys and on-chain value. DeFi/on-chain perps or prediction markets would be a *different* fact pattern, and staff said different facts can void the position.
2. **TSV letters vs 26-09.** If you ever added a purely passive order-entry widget for users who already have an FCM, *without* recommending a venue, marketing contracts, or taking per-trade fees, the older TSV letters are the closer (still non-binding) analogy. Phantom needed 26-09 precisely because it wanted to go beyond those TSV limits.

---

## Bottom line

**Do not treat Letter 26-09 as a compliance program for Spaces Wallet.** It does not cover this product, and this product does not appear to be doing the thing the letter authorizes (with conditions).

If the question is “are we okay because we’re a self-custodial wallet like Phantom’s existing app?” — that is a **different** legal question (CEA/CFTC, state money transmission, BSA, App Store crypto rules, etc.). Letter 26-09 does not answer it.

If the question is “can we ship perpetuals or event contracts in this wallet the way Phantom proposed?” — **not by copying this letter.** That would be new IB-adjacent activity. Counsel would need to decide among registration, a firm-specific no-action request, waiting for Commission rules, or staying out of that market.
