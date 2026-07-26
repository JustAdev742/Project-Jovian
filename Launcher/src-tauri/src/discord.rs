// discord.rs — optional Discord Rich Presence ("Playing Project Nova").
//
// To enable: create an app at https://discord.com/developers/applications,
// upload an asset named "logo", and paste the Application (Client) ID below.
// Left as 0 => fully disabled (every call no-ops), so the launcher never depends on it.

use discord_rpc_client::Client;
use lazy_static::lazy_static;
use std::sync::Mutex;

const DISCORD_CLIENT_ID: u64 = 0; // <-- put your Discord Application ID here to turn it on

lazy_static! {
    static ref RPC: Mutex<Option<Client>> = Mutex::new(None);
}

/// Connect to Discord (on a background thread) and set the initial presence.
pub fn init() {
    if DISCORD_CLIENT_ID == 0 {
        return;
    }
    std::thread::spawn(|| {
        let mut client = Client::new(DISCORD_CLIENT_ID);
        client.start();
        let _ = client.set_activity(|a| {
            a.state("In the Launcher")
                .details("Project Nova — Fortnite 7.40")
                .assets(|ass| ass.large_image("logo").large_text("Project Nova"))
        });
        if let Ok(mut guard) = RPC.lock() {
            *guard = Some(client);
        }
    });
}

/// Update the presence text (e.g. when a match launches). Safe no-op if disabled.
pub fn set_presence(state: &str, details: &str) {
    if let Ok(mut guard) = RPC.lock() {
        if let Some(client) = guard.as_mut() {
            let _ = client.set_activity(|a| {
                a.state(state.to_string())
                    .details(details.to_string())
                    .assets(|ass| ass.large_image("logo").large_text("Project Nova"))
            });
        }
    }
}
