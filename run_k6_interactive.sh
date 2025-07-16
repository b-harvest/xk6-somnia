#!/usr/bin/env bash
# =============================================================================
# run_k6_interactive.sh – interactive wrapper for k6 RPC load-tests
#   • Works with Bash ≥ 3 and zsh (Linux / macOS)
#   • Optional auto-install of gum / fzf (with user confirmation)
#   • Every prompt value is exported AND stored in .k6_env for reuse
# =============================================================================
set -euo pipefail

###############################################################################
# 0. Persistent env-file helpers
###############################################################################
ENV_FILE="${ENV_FILE:-.k6_env}"

[[ -f $ENV_FILE ]] && source "$ENV_FILE"  # shellcheck source=/dev/null

save_env() {               # save_env VAR
  local var="$1" val="${!var}"
  grep -q "^export $var=" "$ENV_FILE" 2>/dev/null &&
    sed -i'' -e "s|^export $var=.*|export $var=\"${val//\"/\\\"}\"|" "$ENV_FILE" ||
    echo "export $var=\"${val//\"/\\\"}\"" >> "$ENV_FILE"
}

###############################################################################
# 1. Optional package auto-installer
###############################################################################
install_prompt() {         # install_prompt CMD PKGNAME
  local cmd="$1" pkg="$2" ans
  command -v "$cmd" &>/dev/null && return 0
  read -rp "$pkg ($cmd) is not installed. Install it? (Y/n): " ans
  [[ -n $ans && $ans =~ ^[Nn]$ ]] && return 1

  echo "→ Installing $pkg …"
  if   command -v brew   &>/dev/null; then brew install "$pkg"
  elif command -v apt-get&>/dev/null; then sudo apt-get update && sudo apt-get install -y "$pkg"
  elif command -v yum    &>/dev/null; then sudo yum install -y "$pkg"
  elif command -v pacman &>/dev/null; then sudo pacman -Sy --noconfirm "$pkg"
  else
    echo "No supported package manager found (brew / apt / yum / pacman)."
    return 1
  fi
}

install_prompt gum gum || install_prompt fzf fzf || true

###############################################################################
# 2. Prompt helpers
###############################################################################
ask_reuse() {              # ask_reuse VAR "Description"
  local var="$1" desc="$2" ans
  if [[ -n ${!var-} ]]; then
    read -rp "$desc is already set. Re-use it? (Y/n): " ans
    [[ -z $ans || $ans =~ ^[Yy]$ ]] && return 0
    unset "$var"
  fi
  return 1
}

prompt_secret() {          # prompt_secret VAR "Prompt"
  local var="$1" prompt="$2" val
  while :; do
    read -rsp "$prompt: " val && echo
    [[ -n $val ]] && { export "$var"="$val"; save_env "$var"; break; }
  done
}

prompt_plain() {           # prompt_plain VAR "Prompt"
  local var="$1" prompt="$2" val
  while :; do
    read -rp "$prompt: " val
    [[ -n $val ]] && { export "$var"="$val"; save_env "$var"; break; }
  done
}

# ---------------------------------------------------------------------------
# SAFE multi-select: never crashes even when user presses Esc / Ctrl-C, etc.
# ---------------------------------------------------------------------------
choose_multi() {      # choose_multi ARRAY_NAME TITLE   →  global SEL=()
  local arr_name="$1" title="$2"
  local arr; eval "arr=( \"\${${arr_name}[@]}\" )"
  SEL=()

  # helper: run a command with -e and pipefail temporarily disabled
  _safe() { ( set +e +o pipefail; "$@" ); }

  if command -v gum >/dev/null 2>&1; then
    local out
    out=$(_safe printf '%s\n' "${arr[@]}" | _safe gum choose --no-limit --header="$title")
    [[ -n $out ]] && SEL=($out)

  elif command -v fzf >/dev/null 2>&1; then
    local out
    out=$(_safe printf '%s\n' "${arr[@]}" | _safe fzf --multi --prompt="$title > ")
    [[ -n $out ]] && SEL=($out)
  fi

  # Manual numeric fallback or “Esc”/empty pick → use all
  if [[ ${#SEL[@]} -eq 0 ]]; then
    printf '\nSelect %s (space-separated numbers | all | Enter=all):\n' "$title"
    local reply idx=1
    for item in "${arr[@]}"; do printf "  %2d) %s\n" "$idx" "$item"; ((idx++)); done
    read -rp '→ ' reply || true               # don’t crash on Ctrl-D
    if [[ -z $reply || $reply == all ]]; then
      SEL=("${arr[@]}")
    else
      SEL=()
      for n in $reply; do
        [[ $n =~ ^[0-9]+$ && n -ge 1 && n -le ${#arr[@]} ]] && SEL+=("${arr[$((n-1))]}")
      done
      [[ ${#SEL[@]} -eq 0 ]] && SEL=("${arr[@]}")
    fi
  fi
}



###############################################################################
# 3. Mandatory global environment variables
###############################################################################
if ! ask_reuse PRIVATE_KEY "PRIVATE_KEY";             then prompt_secret PRIVATE_KEY "Enter PRIVATE_KEY (hex, no 0x)"; fi
if ! ask_reuse WALLET_ADDRESS "WALLET_ADDRESS";       then prompt_plain  WALLET_ADDRESS "Enter WALLET_ADDRESS (0x…)"; fi
if ! ask_reuse INFLUXDB "INFLUXDB URL";              then prompt_plain  INFLUXDB "Enter INFLUXDB URL (http://host:8086)"; fi
if ! ask_reuse K6_INFLUXDB_TOKEN "K6_INFLUXDB_TOKEN"; then prompt_secret K6_INFLUXDB_TOKEN "Enter K6 InfluxDB token"; fi
if ! ask_reuse K6_INFLUXDB_ORGANIZATION "K6_INFLUXDB_ORGANIZATION"; then \
     prompt_plain K6_INFLUXDB_ORGANIZATION "Enter K6 InfluxDB organization"; fi
if ! ask_reuse K6_INFLUXDB_BUCKET "K6_INFLUXDB_BUCKET"; then \
     prompt_plain K6_INFLUXDB_BUCKET "Enter K6 InfluxDB bucket"; fi
if ! ask_reuse REGION "REGION"; then \
     prompt_plain REGION "Enter REGION (e.g., ap-northeast-1)"; fi

###############################################################################
# 4. k6 binary & script
###############################################################################
K6_BIN="${K6_BIN:-./k6}"
SCRIPT_PATH="${SCRIPT_PATH:-perf/somnia_rpc_perf.js}"
[[ -x $K6_BIN ]]   || { echo "ERROR: k6 binary not found at '$K6_BIN'"; exit 1; }
[[ -f $SCRIPT_PATH ]] || { echo "ERROR: k6 script not found at '$SCRIPT_PATH'"; exit 1; }

IFS='://' read -r proto rest <<<"$INFLUXDB"                # split proto://host...
[[ -z $proto || -z $rest ]] && { echo "Invalid INFLUXDB URL '$INFLUXDB'"; exit 1; }

K6_OUT_DSN="xk6-influxdb=${INFLUXDB}?org=${K6_INFLUXDB_ORGANIZATION}&bucket=${K6_INFLUXDB_BUCKET}&token=${K6_INFLUXDB_TOKEN}"
K6_OUT_ARG=(-o "$K6_OUT_DSN")
echo "✔ Using xk6-influxdb output → $INFLUXDB (${K6_INFLUXDB_BUCKET})"

###############################################################################
# 5. Defaults
###############################################################################
DEFAULT_RPCS=(
  "https://dream-rpc.somnia.network/"
#  "https://rpc.ankr.com/somnia_testnet/..."
  "https://shannon-somnia.bharvest.io"
#  "https://rpc.ankr.com/somnia_testnet/58b536ebfc87580ea072c713884b394a6d0d6cdb571c3727238ab5415fcf6dda"
)
DEFAULT_PROFILES=(baseline spike_200 ramp_find_max break_steady spike_10k spike_20k spike_30k spike_28k spike_25k spike_24k spike_26k spike_15k spike_13k spike_5k steady_900 steady_20k steady_5k steady_10k steady_12k steady_17k steady_15k steady_50 steady_13k steady_14k)
DEFAULT_SCENARIOS=(
  S1_BlockNumber S2_ChainId S3_GetBalance S4_GetCode
  S5_EthCallSimple S6_EthCallHeavy S7_GetLogsSmall S8_GetLogsRange
  S9_GetBlockLight S10_GetBlockFull S11_SendRawTxSmall S12_SendRawTxERC20
  S13_PendingTxSub S14_NewHeadSub S15_LogsSubFilter S16_UnsubscribeWS
  S17_EstimateGas S18_GetTxReceipt S19_BatchCalls S20_HttpHandshake
)
PER_RPC_VU_DEFAULT=1
SLEEP_PROFILES=300
SLEEP_SCENARIOS=600

###############################################################################
# 6. Interactive customisation
###############################################################################
read -rp $'\nRPC endpoints (comma-separated, Enter=defaults): ' RPC_INPUT
if [[ -z $RPC_INPUT ]]; then
  RPCS=("${DEFAULT_RPCS[@]}")
else
  IFS=',' read -r -a RPCS <<< "${RPC_INPUT// /}"
fi

choose_multi DEFAULT_PROFILES  "Load profiles" ; PROFILES=("${SEL[@]}")
choose_multi DEFAULT_SCENARIOS "Scenarios"     ; SCENARIOS=("${SEL[@]}")

read -rp $'\nVUs per RPC endpoint [default 1]: ' tmp
PER_RPC_VU="${tmp:-$PER_RPC_VU_DEFAULT}"
RPC_URLS_STR=$(IFS=,; echo "${RPCS[*]}")

###############################################################################
# 7. Per-scenario variable checker / prompter
###############################################################################
require_var() {            # require_var VAR PROMPT SECRET? (0 = ok, 1 = skip)
  local var="$1" prompt="$2" secret="${3:-plain}" val
  [[ -n ${!var-} ]] && return 0

  echo "Scenario '$scenario' needs $var."
  if [[ $secret == secret ]]; then
    read -rsp "Enter $prompt (or press Enter to skip this scenario): " val && echo
  else
    read -rp  "Enter $prompt (or press Enter to skip this scenario): " val
  fi

  [[ -z $val ]] && return 1        # skip scenario
  export "$var"="$val"; save_env "$var"
  return 0
}

scenario_prepare() {       # scenario_prepare SCENARIO  (0=run, 1=skip)
  scenario="$1"
  case "$scenario" in
    S3_GetBalance)
       require_var TEST_ADDRESS  "TEST_ADDRESS (0x…)"            plain   || return 1 ;;
    S4_GetCode|S5_EthCallSimple|S6_EthCallHeavy|S15_LogsSubFilter|S17_EstimateGas)
       require_var CONTRACT_ADDRESS "CONTRACT_ADDRESS (0x…)"     plain   || return 1 ;;
    S12_SendRawTxERC20)
       require_var ERC20_TOKEN "ERC20_TOKEN address (0x…)"        plain   || return 1 ;;
    S16_UnsubscribeWS)
       require_var SUB_ID "subscription ID"                       plain   || return 1 ;;
    S18_GetTxReceipt)
       require_var TX_HASH "TX_HASH (0x…)"                        plain   || return 1 ;;
    S17_EstimateGas)
       require_var EST_DATA "raw tx data (hex)"                   plain   || return 1 ;;
  esac
  return 0
}

###############################################################################
# 8. Execution loops
###############################################################################
for scenario in "${SCENARIOS[@]}"; do
  if ! scenario_prepare "$scenario"; then
    echo "→ Skipping $scenario (required variable not provided)."
    continue
  fi

  for profile in "${PROFILES[@]}"; do
    printf '\n\033[1;36m▶ %s | %s\033[0m\n' "$scenario" "$profile"
    RUN_ID="run_$(date +%Y%m%d_%H%M%S)_${scenario}_${profile}"

    env \
      PRIVATE_KEY="$PRIVATE_KEY" \
      WALLET_ADDRESS="$WALLET_ADDRESS" \
      INFLUXDB="$INFLUXDB" \
      K6_INFLUXDB_TOKEN="$K6_INFLUXDB_TOKEN" \
      K6_INFLUXDB_ORGANIZATION="$K6_INFLUXDB_ORGANIZATION" \
      K6_INFLUXDB_BUCKET="$K6_INFLUXDB_BUCKET" \
      RPC_URLS="$RPC_URLS_STR" \
      SCENARIO_TYPE="$scenario" \
      LOAD_PROFILE="$profile" \
      PER_RPC_VU="$PER_RPC_VU" \
      REGION="$REGION" \
      ${CONTRACT_ADDRESS:+CONTRACT_ADDRESS="$CONTRACT_ADDRESS"} \
      ${TEST_ADDRESS:+TEST_ADDRESS="$TEST_ADDRESS"} \
      ${ERC20_TOKEN:+ERC20_TOKEN="$ERC20_TOKEN"} \
      ${SUB_ID:+SUB_ID="$SUB_ID"} \
      ${TX_HASH:+TX_HASH="$TX_HASH"} \
      ${EST_DATA:+EST_DATA="$EST_DATA"} \
      ${START_BLOCK:+START_BLOCK="$START_BLOCK"} \
      ${END_BLOCK:+END_BLOCK="$END_BLOCK"} \
    "$K6_BIN" run \
      --tag run_id="$RUN_ID" \
      --tag scenario="$scenario" \
      --tag profile="$profile" \
      --tag region="$REGION" \
      "${K6_OUT_ARG[@]}" \
      "$SCRIPT_PATH"

    status=$?
    if (( status != 0 )); then
      echo "k6 failed (exit $status) for $scenario / $profile"
      exit $status
    fi

    echo "✔ Finished $scenario @ $profile – sleeping ${SLEEP_PROFILES}s"
    sleep "$SLEEP_PROFILES"
  done

  echo "Waiting ${SLEEP_SCENARIOS}s before starting the next scenario group…"
  sleep "$SLEEP_SCENARIOS"
done

echo -e "\nAll scenario × profile runs are complete. Check your Grafana / InfluxDB dashboards."
echo "(Your variables are saved in '$ENV_FILE' and will auto-load next time.)"