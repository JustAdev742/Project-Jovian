// Standalone check of Nova::Diag::Redact — the function that must stop a live bearer token leaving
// the machine. Cobalt hooks the call that sets curl's URL, so it sees these routinely.
#include "diagnostics.h"
#include <cstdio>
#include <string>
#include <vector>

static int failures = 0;

static void mustNotContain(const char* name, const std::string& out, const char* secret)
{
    if (out.find(secret) != std::string::npos) {
        printf("  FAIL %-46s leaked: %s\n", name, out.c_str());
        ++failures;
    } else {
        printf("  ok   %-46s -> %s\n", name, out.c_str());
    }
}

static void mustEqual(const char* name, const std::string& got, const std::string& want)
{
    if (got != want) {
        printf("  FAIL %-46s got: %s\n", name, got.c_str());
        ++failures;
    } else {
        printf("  ok   %-46s (unchanged)\n", name);
    }
}

int main()
{
    using Nova::Diag::Redact;

    // The real shape 7.40 sends on sign-out, token in the URL PATH.
    const std::string jwt = "eyJhbGciOiJIUzI1NiIsImtpZCI6ImNhbmFyeSJ9.eyJzdWIiOiJ4In0.SiGnAtUrE";
    mustNotContain("eg1~ token in a path",
        Redact("/account/api/oauth/sessions/kill/eg1~" + jwt), "SiGnAtUrE");
    mustNotContain("bare JWT",
        Redact("Authorization failed for " + jwt), "SiGnAtUrE");
    mustNotContain("access_token query param",
        Redact("/x?access_token=eg1~" + jwt + "&other=keepme"), "SiGnAtUrE");
    mustNotContain("password query param",
        Redact("/login?password=hunter2"), "hunter2");
    mustNotContain("token at end of string",
        Redact("eg1~" + jwt), "SiGnAtUrE");
    mustNotContain("two tokens in one string",
        Redact("a=eg1~" + jwt + " b=eg1~" + jwt), "SiGnAtUrE");

    // Must NOT mangle ordinary text — over-redaction destroys the diagnostic value.
    mustEqual("ordinary route untouched",
        Redact("/fortnite/api/game/v2/matchmakingservice/ticket/player/abc123"),
        "/fortnite/api/game/v2/matchmakingservice/ticket/player/abc123");
    mustEqual("plain sentence untouched",
        Redact("Gameserver exited (code=3221225477)"),
        "Gameserver exited (code=3221225477)");
    mustEqual("empty string",  Redact(""), "");

    // A non-secret value that merely starts like a JWT prefix must survive.
    mustEqual("eyJ without two dots is not a JWT",
        Redact("eyJustAName"), "eyJustAName");

    // Query params that keep the following value are still readable after the secret.
    {
        std::string out = Redact("/x?access_token=eg1~" + jwt + "&other=keepme");
        if (out.find("other=keepme") == std::string::npos) {
            printf("  FAIL %-46s lost the non-secret param: %s\n", "text after a redacted param", out.c_str());
            ++failures;
        } else {
            printf("  ok   %-46s\n", "text after a redacted param survives");
        }
    }

    printf("\n%s (%d failure%s)\n", failures ? "FAILED" : "PASSED", failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
