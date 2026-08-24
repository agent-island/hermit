// A model may correctly background a long-lived process with `&`, but Bash can
// background an entire compound list (`cd x && server &`) as an orphan shell.
// That shell inherits the transport's stdout/stderr even when the server itself
// redirects them, so SSH never observes EOF and run() never returns.
//
// Spool the submitted script and all of its output inside the guest. Background
// descendants may keep the temporary output inode open, but they never inherit
// the SSH pipes. The foreground script can finish, its output is copied back,
// and the transport closes normally.
export function guestShellRunner(timeoutSeconds = 300, { timezone = "" } = {}) {
  const timeout = Math.max(1, Math.round(Number(timeoutSeconds) || 300));
  const zone = String(timezone || "").trim();
  if (zone && !/^[A-Za-z0-9_+\-/]+$/.test(zone)) {
    throw new Error(`invalid timezone ${JSON.stringify(zone)}`);
  }
  const environment = `DEBIAN_FRONTEND=noninteractive${zone ? ` TZ=${zone}` : ""}`;
  return [
    'cd "$HOME" || exit 1',
    "ami_script=$(mktemp)",
    "ami_output=$(mktemp)",
    'cat >"$ami_script"',
    `timeout ${timeout} env ${environment} bash "$ami_script" >"$ami_output" 2>&1`,
    "ami_status=$?",
    'cat "$ami_output"',
    'rm -f "$ami_script" "$ami_output"',
    'exit "$ami_status"',
  ].join("; ");
}

export function limaShellCommand({ user = "", timeoutSeconds = 300, timezone = "" } = {}) {
  const account = String(user || "").trim();
  if (account && !/^[a-z_][a-z0-9_-]*$/i.test(account)) {
    throw new Error(`invalid VM account ${JSON.stringify(account)}`);
  }
  // `sudo -i` adds another login-shell parser. It expanded the runner's
  // $ami_script variables before the runner started, turning every path into
  // an empty string. -H selects the target home without that extra shell.
  const identity = account ? `sudo -u ${account} -H -- ` : "";
  return `export LIMA_HOME=$HOME/.lima; $HOME/lima/bin/limactl shell box ${identity}sh -c '${guestShellRunner(timeoutSeconds, { timezone })}'`;
}
