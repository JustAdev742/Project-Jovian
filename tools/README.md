# tools

## `binscan.js` — ask the client binary directly

The Fortnite client is the most authoritative evidence source this project has for any
version-specific question, and it is the cheapest one to consult. It has already settled several
questions that documentation and inference could not:

- **Party is V1 on 7.40.** `bUsePartySystemV2` and `OnlinePartySystemMcpAdapter` appear **0** times,
  so the V2 REST API is not on this build's path at all.
- **7.40 is an MCP build, not EOS.** `EOS_Initialize` and `ProductUserId`: **0** occurrences.
- **`mutualPrivacy` does not exist on 7.40.** The friend-settings field the modern endpoint
  documentation shows is absent, so Nova omitting it is correct — adding it would have been an
  anachronism imported from a later era.

```bash
# does this build know about a symbol?  (checks ASCII and UTF-16LE)
node tools/binscan.js <exe> count mutualPrivacy acceptInvites

# extract every literal matching a pattern
node tools/binscan.js <exe> regex "Playlist_[A-Za-z0-9_]{2,40}"
```

The 7.40 client is at
`C:\Users\Admin\Downloads\v7.40\7.40\FortniteGame\Binaries\Win64\FortniteClient-Win64-Shipping.exe`
(the launcher records this path in `%LOCALAPPDATA%\Project Launcher\launcher-startup.log`).

### Two traps that will give you a wrong answer

**1. Search both encodings.** UE4 stores `FString` / `TEXT()` literals as **UTF-16LE**, while
`char*` literals (URLs handed to curl) are ASCII. Searching only ASCII reports `acceptInvites` as
absent when it is present as UTF-16 — a false negative that reads exactly like a real finding.
`binscan.js` always checks both and prints each count separately.

**2. Git Bash rewrites arguments that start with `/`.** MSYS path conversion turns `/fortnite/api`
into `C:/Program Files/Git/fortnite/api`, so every path-shaped search silently returns zero. Always:

```bash
export MSYS_NO_PATHCONV=1
```

This one produced a confident "the client contains no API paths" before it was caught.

### Always run controls, in both directions

A scan with no control proves nothing — an encoding mistake or a mangled argument looks identical to
a genuine absence. Every result recorded in `VERSION_COMPATIBILITY.md` was taken alongside:

- **positive controls** that must be PRESENT (`QueryProfile`, `enabled_features`,
  `reserveGeneralChatRooms`), and
- **negative controls** that must be ABSENT (`bUsePartySystemV2`, `EOS_Initialize`).

If a positive control comes back absent, the scan is broken — not the build.

### What a hit does and does not mean

A string in the binary proves the build **contains** that literal. It does **not** prove any
reachable code path uses it: shipping binaries carry code for platforms, storefronts and modes this
deployment never touches. Treat presence as "this build knows the name" and absence as strong
evidence of "this build cannot use it" — absence is the more conclusive direction, because a JSON
field the client parses must appear as a literal somewhere.
