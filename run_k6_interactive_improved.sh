#!/usr/bin/env bash
# =============================================================================
# run_k6_interactive_improved.sh – Enhanced k6 RPC load test orchestrator
#   • Expert-level k6 integration with advanced monitoring and control
#   • Production-ready Linux/macOS best practices and error handling
#   • Resource management, signal handling, and performance optimization
#   • Advanced logging, metrics collection, and health checks
#   • Compatible with bash ≥ 3.2 and zsh
#   • OPTIONAL InfluxDB integration for metrics storage
# =============================================================================
set -euo pipefail

# Debug trap for errors with better context
trap 'echo "Error on line $LINENO: Command failed with exit code $?" >&2; echo "Last command: ${BASH_COMMAND:-unknown}" >&2' ERR

# Debug will be enabled after parsing command line arguments

# Ensure compatibility with both bash and zsh
if [[ -n "${ZSH_VERSION:-}" ]]; then
    # zsh specific settings
    setopt BASH_REMATCH      # Enable bash regex compatibility
    setopt KSH_ARRAYS        # Array indexing starts at 0
    setopt NO_NOMATCH        # Don't error on failed glob
fi

###############################################################################
# 0. Constants and Configuration
###############################################################################
readonly SCRIPT_VERSION="2.1.0"
readonly SCRIPT_NAME="$(basename "${BASH_SOURCE[0]:-$0}")"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# Configuration paths
readonly ENV_FILE="${ENV_FILE:-.k6_env}"
readonly CONFIG_DIR="${CONFIG_DIR:-$SCRIPT_DIR/perf/config}"
readonly LOG_DIR="${LOG_DIR:-$SCRIPT_DIR/logs}"
readonly RESULTS_DIR="${RESULTS_DIR:-$SCRIPT_DIR/results}"
readonly LOCK_FILE="${LOCK_FILE:-/tmp/k6_test.lock}"

# Performance tuning
readonly MAX_PARALLEL_JOBS="${MAX_PARALLEL_JOBS:-1}"
readonly MEMORY_LIMIT="${MEMORY_LIMIT:-8G}"
readonly CPU_LIMIT="${CPU_LIMIT:-4}"

# Colors for output (disabled if not terminal)
if [[ -t 1 ]]; then
    readonly RED='\033[0;31m'
    readonly GREEN='\033[0;32m'
    readonly YELLOW='\033[0;33m'
    readonly BLUE='\033[0;34m'
    readonly MAGENTA='\033[0;35m'
    readonly CYAN='\033[0;36m'
    readonly BOLD='\033[1m'
    readonly RESET='\033[0m'
else
    readonly RED='' GREEN='' YELLOW='' BLUE='' MAGENTA='' CYAN='' BOLD='' RESET=''
fi

# Logging functions
log_info()    { echo -e "${BLUE}[INFO]${RESET} $(date '+%Y-%m-%d %H:%M:%S') - $*" | ${LOG_FILE:+tee -a "$LOG_FILE" ||} cat; }
log_success() { echo -e "${GREEN}[SUCCESS]${RESET} $(date '+%Y-%m-%d %H:%M:%S') - $*" | ${LOG_FILE:+tee -a "$LOG_FILE" ||} cat; }
log_warn()    { echo -e "${YELLOW}[WARN]${RESET} $(date '+%Y-%m-%d %H:%M:%S') - $*" | ${LOG_FILE:+tee -a "$LOG_FILE" ||} cat; }
log_error()   { echo -e "${RED}[ERROR]${RESET} $(date '+%Y-%m-%d %H:%M:%S') - $*" | ${LOG_FILE:+tee -a "$LOG_FILE" ||} cat >&2; }
log_debug()   { [[ "${DEBUG:-0}" == "1" ]] || return 0; echo -e "${MAGENTA}[DEBUG]${RESET} $(date '+%Y-%m-%d %H:%M:%S') - $*" | ${LOG_FILE:+tee -a "$LOG_FILE" ||} cat; }

###############################################################################
# 1. System checks and initialization
###############################################################################
init_environment() {
    # Create necessary directories
    mkdir -p "$LOG_DIR" "$RESULTS_DIR"

    # Initialize log file
    readonly LOG_FILE="$LOG_DIR/k6_interactive_$(date +%Y%m%d_%H%M%S).log"
    touch "$LOG_FILE"

    log_info "Starting $SCRIPT_NAME v$SCRIPT_VERSION"
    log_info "Log file: $LOG_FILE"

    # Check system resources
    check_system_resources

    # Load existing environment if available
    if [[ -f "$ENV_FILE" ]]; then
        log_info "Loading environment from $ENV_FILE"
        # Validate env file before sourcing
        if grep -E '^[A-Z_]+=' "$ENV_FILE" | grep -qv '^export '; then
            log_warn "Environment file contains non-export statements, cleaning up..."
            # Use portable sed syntax
            if [[ "$(uname)" == "Darwin" ]]; then
                sed -i '.bak' 's/^\([A-Z_]*=\)/export \1/' "$ENV_FILE"
            else
                sed -i.bak 's/^\([A-Z_]*=\)/export \1/' "$ENV_FILE"
            fi
        fi
        # Source with proper shell compatibility
        if [[ -n "${BASH_VERSION:-}" ]]; then
            source "$ENV_FILE" # shellcheck source=/dev/null
        else
            # zsh
            . "$ENV_FILE"
        fi
    fi

    # Load InfluxDB configuration if available and if we're using InfluxDB
    if [[ "${USE_INFLUXDB:-1}" == "1" ]]; then
        local INFLUX_CONFIG_FILE="${INFLUX_CONFIG_FILE:-.k6_influxdb_config}"
        if [[ -f "$INFLUX_CONFIG_FILE" ]]; then
            log_info "Loading InfluxDB configuration from $INFLUX_CONFIG_FILE"
            if [[ -n "${BASH_VERSION:-}" ]]; then
                source "$INFLUX_CONFIG_FILE" # shellcheck source=/dev/null
            else
                # zsh
                . "$INFLUX_CONFIG_FILE"
            fi
        fi
    fi

    # Set process limits (non-fatal if they fail)
    ulimit -n 65536 2>/dev/null || log_warn "Could not increase file descriptor limit"
    ulimit -u 32768 2>/dev/null || log_warn "Could not increase user process limit"
}

check_system_resources() {
    local available_memory available_cpu

    # Memory check - Linux vs macOS
    if command -v free &>/dev/null; then
        # Linux
        available_memory=$(free -g | awk '/^Mem:/{print $7}')
        log_info "Available memory: ${available_memory}GB"

        if [[ $available_memory -lt 4 ]]; then
            log_warn "Low memory detected. k6 performance may be impacted."
        fi
    elif command -v vm_stat &>/dev/null; then
        # macOS
        local pages_free pages_size
        pages_free=$(vm_stat | awk '/Pages free:/ {print $3}' | sed 's/\.//')
        pages_size=$(pagesize 2>/dev/null || echo 4096)
        available_memory=$(( (pages_free * pages_size) / 1024 / 1024 / 1024 ))
        log_info "Available memory: ~${available_memory}GB"

        if [[ $available_memory -lt 4 ]]; then
            log_warn "Low memory detected. k6 performance may be impacted."
        fi
    fi

    # CPU check - Linux vs macOS
    if [[ -f /proc/cpuinfo ]]; then
        # Linux
        available_cpu=$(grep -c ^processor /proc/cpuinfo)
        log_info "Available CPUs: $available_cpu"
    elif command -v sysctl &>/dev/null; then
        # macOS
        available_cpu=$(sysctl -n hw.ncpu 2>/dev/null || echo "unknown")
        log_info "Available CPUs: $available_cpu"
    fi

    # Disk space check - portable
    if command -v df &>/dev/null; then
        local available_disk
        # Use portable df options
        if [[ "$(uname)" == "Darwin" ]]; then
            # macOS - use -g for GB
            available_disk=$(df -g "$SCRIPT_DIR" 2>/dev/null | awk 'NR==2 {print $4}')
        else
            # Linux - use -BG
            available_disk=$(df -BG "$SCRIPT_DIR" 2>/dev/null | awk 'NR==2 {print $4}' | sed 's/G//')
        fi

        if [[ -n $available_disk && $available_disk -lt 1 ]]; then
            log_warn "Low disk space: ${available_disk}GB available"
        fi
    fi
}

###############################################################################
# 2. Signal handling and cleanup
###############################################################################
cleanup() {
    local exit_code=$?

    # Kill monitoring processes if any
    if [[ -n "${MONITOR_PID:-}" ]] && kill -0 "$MONITOR_PID" 2>/dev/null; then
        kill "$MONITOR_PID" 2>/dev/null || true
    fi

    # Release lock
    if [[ -d "$LOCK_FILE" ]]; then
        rm -rf "$LOCK_FILE"
    fi

    # Save state for resumption
    if [[ -n "${CURRENT_SCENARIO:-}" ]] && [[ -n "${CURRENT_PROFILE:-}" ]]; then
        echo "LAST_SCENARIO=$CURRENT_SCENARIO" > "$SCRIPT_DIR/.k6_state"
        echo "LAST_PROFILE=$CURRENT_PROFILE" >> "$SCRIPT_DIR/.k6_state"
        echo "LAST_RUN=$(date +%s)" >> "$SCRIPT_DIR/.k6_state"
    fi

    # Log exit reason based on exit code
    case $exit_code in
        0) log_info "Script completed successfully" ;;
        1) log_error "Script failed - check logs above for details" ;;
        130) log_warn "Script interrupted by user (Ctrl+C)" ;;
        *) log_error "Script exited with code: $exit_code" ;;
    esac

    log_info "Cleanup completed (exit code: $exit_code)"
    exit $exit_code
}

# Setup signal handlers
trap cleanup EXIT
trap 'log_warn "Interrupted by user"; exit 130' INT TERM

###############################################################################
# 3. Lock file management
###############################################################################
acquire_lock() {
    local lock_timeout=300  # 5 minutes
    local lock_acquired=0
    local start_time=$(date +%s)

    while [[ $lock_acquired -eq 0 ]]; do
        if mkdir "$LOCK_FILE" 2>/dev/null; then
            echo $$ > "$LOCK_FILE/pid"
            lock_acquired=1
            log_debug "Lock acquired"
        else
            local current_time=$(date +%s)
            local elapsed=$((current_time - start_time))

            if [[ $elapsed -gt $lock_timeout ]]; then
                log_error "Failed to acquire lock after ${lock_timeout}s"
                return 1
            fi

            # Check if lock holder is still alive
            if [[ -f "$LOCK_FILE/pid" ]]; then
                local lock_pid=$(cat "$LOCK_FILE/pid" 2>/dev/null || echo "")
                if [[ -n $lock_pid ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
                    log_warn "Removing stale lock from PID $lock_pid"
                    rm -rf "$LOCK_FILE"
                    continue
                fi
            fi

            log_info "Waiting for lock (held by PID $(cat "$LOCK_FILE/pid" 2>/dev/null || echo 'unknown'))..."
            sleep 5
        fi
    done

    return 0
}

###############################################################################
# 4. Environment validation
###############################################################################
validate_environment() {
    local errors=0

    # Check required binaries (skip k6 since we'll check for local binary separately)
    for cmd in jq curl; do
        if ! command -v "$cmd" &>/dev/null; then
            log_error "Required command '$cmd' not found"
            ((errors++))
        fi
    done

    # Validate k6 binary path - prefer local ./k6 binary
    if [[ ! -x "${K6_BIN:-}" ]]; then
        if [[ -x "./k6" ]]; then
            K6_BIN="./k6"
            log_info "Using local k6 binary: $K6_BIN"
        elif command -v k6 &>/dev/null; then
            K6_BIN=$(command -v k6)
            log_info "Using system k6 binary: $K6_BIN"
        else
            log_error "k6 binary not found (neither ./k6 nor system k6)"
            log_error "Current directory: $(pwd)"
            log_error "Looking for: ./k6 or k6 in PATH"
            ((errors++))
        fi
    fi

    # Validate script path
    if [[ ! -f "${SCRIPT_PATH:-}" ]]; then
        SCRIPT_PATH="$SCRIPT_DIR/perf/somnia_rpc_perf.js"
        if [[ ! -f "$SCRIPT_PATH" ]]; then
            log_error "k6 script not found at $SCRIPT_PATH"
            log_error "Current directory: $(pwd)"
            log_error "Script directory: $SCRIPT_DIR"
            ((errors++))
        fi
    fi

    return $errors
}

###############################################################################
# 5. Input validation helpers
###############################################################################
validate_numeric() {
    local value="$1" name="$2" min="${3:-}" max="${4:-}"

    # Use portable number check
    if ! echo "$value" | grep -qE '^[0-9]+$'; then
        log_error "$name must be a positive integer"
        return 1
    fi

    if [[ -n $min ]] && [[ $value -lt $min ]]; then
        log_error "$name must be at least $min"
        return 1
    fi

    if [[ -n $max ]] && [[ $value -gt $max ]]; then
        log_error "$name must be at most $max"
        return 1
    fi

    return 0
}

validate_url() {
    local url="$1"

    # Basic URL validation
    if ! echo "$url" | grep -qE '^https?://[^[:space:]]+'; then
        log_error "Invalid URL format: $url"
        return 1
    fi

    return 0
}

###############################################################################
# 6. Environment variable management
###############################################################################
save_env() {
    local var="$1"
    local val

    # Handle indirect variable reference portably
    if [[ -n "${BASH_VERSION:-}" ]]; then
        val="${!var}"
    else
        # zsh
        val="${(P)var}"
    fi

    # Check if variable exists in file
    if grep -q "^export $var=" "$ENV_FILE" 2>/dev/null; then
        # Update existing with portable sed
        if [[ "$(uname)" == "Darwin" ]]; then
            sed -i '.bak' "s|^export $var=.*|export $var=\"${val//\"/\\\"}\"|" "$ENV_FILE"
        else
            sed -i.bak "s|^export $var=.*|export $var=\"${val//\"/\\\"}\"|" "$ENV_FILE"
        fi
    else
        # Add new
        echo "export $var=\"${val//\"/\\\"}\"" >> "$ENV_FILE"
    fi

    log_debug "Saved $var to environment file"
}

###############################################################################
# 7. Health checks
###############################################################################
check_influxdb_connection() {
    local influx_url="${INFLUXDB:-}"

    if [[ -z $influx_url ]]; then
        log_error "INFLUXDB URL not set"
        return 1
    fi

    log_info "Checking InfluxDB connection..."

    # Test InfluxDB health endpoint
    local health_url="${influx_url}/health"
    local response
    response=$(curl -s -w "\\n%{http_code}" "$health_url" 2>/dev/null || echo "000")
    local http_code=$(echo "$response" | tail -1)

    if [[ $http_code -eq 200 ]]; then
        log_success "InfluxDB connection successful"
        return 0
    else
        log_error "InfluxDB connection failed (HTTP $http_code)"
        return 1
    fi
}

check_network_connectivity() {
    local test_endpoints=("8.8.8.8" "1.1.1.1")
    local connected=0

    for endpoint in "${test_endpoints[@]}"; do
        if ping -c 1 -W 2 "$endpoint" &>/dev/null; then
            connected=1
            break
        fi
    done

    if [[ $connected -eq 0 ]]; then
        log_warn "No internet connectivity detected"
        return 1
    fi

    return 0
}

###############################################################################
# 8. Resource monitoring
###############################################################################
monitor_system_resources() {
    while true; do
        if command -v free &>/dev/null; then
            # Linux
            local mem_used=$(free -m | awk '/^Mem:/{print int($3/$2*100)}')
            log_debug "Memory usage: ${mem_used}%"

            if [[ $mem_used -gt 90 ]]; then
                log_warn "High memory usage detected: ${mem_used}%"
            fi
        elif command -v vm_stat &>/dev/null; then
            # macOS
            local pages_free=$(vm_stat | awk '/Pages free:/ {print $3}' | sed 's/\.//')
            local pages_active=$(vm_stat | awk '/Pages active:/ {print $3}' | sed 's/\.//')
            local pages_inactive=$(vm_stat | awk '/Pages inactive:/ {print $3}' | sed 's/\.//')
            local pages_wired=$(vm_stat | awk '/Pages wired down:/ {print $3}' | sed 's/\.//')
            local pages_compressed=$(vm_stat | awk '/Pages occupied by compressor:/ {print $5}' | sed 's/\.//')

            local total_used=$((pages_active + pages_inactive + pages_wired + pages_compressed))
            local total_pages=$((total_used + pages_free))
            local mem_used=$((total_used * 100 / total_pages))

            log_debug "Memory usage: ~${mem_used}%"

            if [[ $mem_used -gt 90 ]]; then
                log_warn "High memory usage detected: ${mem_used}%"
            fi
        fi

        if command -v iostat &>/dev/null; then
            local cpu_idle
            if [[ "$(uname)" == "Darwin" ]]; then
                # macOS iostat format
                cpu_idle=$(iostat -c 1 -n 2 | tail -1 | awk '{print $7}')
            else
                # Linux iostat format
                cpu_idle=$(iostat -c 1 2 | tail -1 | awk '{print $NF}')
            fi

            # Remove decimal if present
            cpu_idle=${cpu_idle%.*}
            local cpu_used=$((100 - cpu_idle))
            log_debug "CPU usage: ${cpu_used}%"
        fi

        sleep 30
    done
}

start_monitoring() {
    monitor_system_resources &
    MONITOR_PID=$!
    log_debug "Started resource monitoring (PID: $MONITOR_PID)"
}

###############################################################################
# 9. Interactive prompts
###############################################################################
ask_reuse() {
    local var="$1" desc="$2" current_val

    # Get current value portably
    if [[ -n "${BASH_VERSION:-}" ]]; then
        current_val="${!var}"
    else
        current_val="${(P)var}"
    fi

    if [[ -n "$current_val" ]]; then
        read -rp "$desc is already set to '$current_val'. Re-use it? (Y/n): " ans
        [[ -z $ans || $ans =~ ^[Yy]$ ]] && return 0

        # Clear the variable
        if [[ -n "${BASH_VERSION:-}" ]]; then
            unset "$var"
        else
            unset $var
        fi
    fi
    return 1
}

prompt_secret() {
    local var="$1" prompt="$2" val
    while :; do
        read -rsp "$prompt: " val && echo
        if [[ -n $val ]]; then
            export "$var"="$val"
            save_env "$var"
            break
        fi
        log_warn "Value cannot be empty"
    done
}

prompt_plain() {
    local var="$1" prompt="$2" val
    while :; do
        read -rp "$prompt: " val
        if [[ -n $val ]]; then
            export "$var"="$val"
            save_env "$var"
            break
        fi
        log_warn "Value cannot be empty"
    done
}

choose_multi() {
    local arr_name="$1"
    local title="$2"
    local -a selected=()
    local -a arr_copy

    # Get array content portably
    if [[ -n "${BASH_VERSION:-}" ]]; then
        # bash - use nameref
        local -n arr_ref=$arr_name
        arr_copy=("${arr_ref[@]}")
    else
        # zsh - use P flag
        arr_copy=("${(@P)arr_name}")
    fi

    if command -v gum &>/dev/null; then
        # Use gum for selection
        local selections
        selections=$(printf '%s\n' "${arr_copy[@]}" | gum choose --no-limit --header="$title")

        if [[ -n $selections ]]; then
            while IFS= read -r line; do
                [[ -n $line ]] && selected+=("$line")
            done <<< "$selections"
        fi
    elif command -v fzf &>/dev/null; then
        # Use fzf for selection
        local selections
        selections=$(printf '%s\n' "${arr_copy[@]}" | fzf --multi --prompt="$title > ")

        if [[ -n $selections ]]; then
            while IFS= read -r line; do
                [[ -n $line ]] && selected+=("$line")
            done <<< "$selections"
        fi
    else
        # Manual selection fallback
        log_info "Select $title (space-separated numbers, 'all' for all):"
        local i=1
        for item in "${arr_copy[@]}"; do
            printf "  %2d) %s\n" $i "$item"
            ((i++))
        done

        local choices
        read -rp "Enter selection: " choices

        if [[ $choices == "all" || -z $choices ]]; then
            selected=("${arr_copy[@]}")
        else
            for num in $choices; do
                if echo "$num" | grep -qE '^[0-9]+$' && [[ $num -ge 1 ]] && [[ $num -le ${#arr_copy[@]} ]]; then
                    selected+=("${arr_copy[$((num-1))]}")
                fi
            done
        fi
    fi

    # Return selected items
    if [[ ${#selected[@]} -eq 0 ]]; then
        # If nothing selected, default to all
        selected=("${arr_copy[@]}")
    fi

    # Set global variable SEL with results
    SEL=("${selected[@]}")
}

###############################################################################
# 10. Scenario requirements checking
###############################################################################
require_var() {
    local var="$1" prompt="$2" secret="${3:-plain}" val current_val

    # Get current value portably
    if [[ -n "${BASH_VERSION:-}" ]]; then
        current_val="${!var}"
    else
        current_val="${(P)var}"
    fi

    [[ -n "$current_val" ]] && return 0

    echo "Scenario '$CURRENT_SCENARIO' requires $var."
    if [[ $secret == "secret" ]]; then
        read -rsp "Enter $prompt (or press Enter to skip this scenario): " val && echo
    else
        read -rp  "Enter $prompt (or press Enter to skip this scenario): " val
    fi

    [[ -z $val ]] && return 1  # Skip scenario

    export "$var"="$val"
    save_env "$var"
    return 0
}

scenario_prepare() {
    local scenario="$1"
    case "$scenario" in
        S3_GetBalance)
            require_var TEST_ADDRESS "TEST_ADDRESS (0x…)" plain || return 1 ;;
        S4_GetCode|S5_EthCallSimple|S6_EthCallHeavy|S15_LogsSubFilter)
            require_var CONTRACT_ADDRESS "CONTRACT_ADDRESS (0x…)" plain || return 1 ;;
        S12_SendRawTxERC20)
            require_var ERC20_TOKEN "ERC20_TOKEN address (0x…)" plain || return 1 ;;
        S16_UnsubscribeWS)
            require_var SUB_ID "subscription ID" plain || return 1 ;;
        S18_GetTxReceipt)
            require_var TX_HASH "TX_HASH (0x…)" plain || return 1 ;;
        S17_EstimateGas)
            # Enhanced gas estimation - all variables are optional
            log_info "Gas estimation scenario supports both custom and automatic transaction building"
            if [[ -n "${EST_DATA:-}" ]] && [[ -n "${EST_CONTRACT:-}" ]]; then
                log_info "Using custom gas estimation: contract=${EST_CONTRACT}, data=${EST_DATA:0:20}..."
                # Validate contract address format
                if [[ ! "$EST_CONTRACT" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
                    log_error "EST_CONTRACT must be a valid Ethereum address (0x...)"
                    return 1
                fi
                # Validate data format
                if [[ ! "$EST_DATA" =~ ^0x[a-fA-F0-9]*$ ]]; then
                    log_error "EST_DATA must be valid hex data (0x...)"
                    return 1
                fi
            else
                log_info "Using automatic transaction building (12 realistic scenarios)"
                log_info "Scenarios: legacy, eip20, eip721, eip1155, create, create2, eip1967, eip2771, multicall, eip2535"
            fi

            # Optional: prompt for custom gas estimation variables if interactive
            if [[ $NON_INTERACTIVE -eq 0 ]]; then
                if [[ -z "${EST_CONTRACT:-}" ]]; then
                    read -rp "Enter EST_CONTRACT (0x...) or press Enter for automatic: " EST_CONTRACT
                    if [[ -n "$EST_CONTRACT" ]]; then
                        export EST_CONTRACT
                        save_env EST_CONTRACT
                    fi
                fi

                if [[ -z "${EST_DATA:-}" ]]; then
                    read -rp "Enter EST_DATA (0x...) or press Enter for automatic: " EST_DATA
                    if [[ -n "$EST_DATA" ]]; then
                        export EST_DATA
                        save_env EST_DATA
                    fi
                fi

                if [[ -z "${EST_VALUE:-}" ]]; then
                    read -rp "Enter EST_VALUE (0x...) or press Enter for 0x0: " EST_VALUE
                    if [[ -n "$EST_VALUE" ]]; then
                        export EST_VALUE
                        save_env EST_VALUE
                    fi
                fi
            fi
            ;;
    esac
    return 0
}

###############################################################################
# 11. Test execution
###############################################################################
run_k6_test() {
    local scenario="$1"
    local profile="$2"
    local run_id="$3"

    log_info "Starting k6 test: $scenario @ $profile"
    log_debug "Using k6 binary: $K6_BIN"
    log_debug "Using script: $SCRIPT_PATH"

    # Build k6 command with metric reduction
    local -a k6_args=(
        run
        --tag "run_id=$run_id"
        --tag "scenario=$scenario"
        --tag "profile=$profile"
    )

    # Add output args if configured (only if using InfluxDB)
    if [[ "${USE_INFLUXDB:-1}" == "1" ]] && [[ -n "${K6_OUT_ARG[@]:-}" ]]; then
        k6_args+=("${K6_OUT_ARG[@]}")
        log_info "Metrics will be sent to InfluxDB"
    else
        log_info "Running without InfluxDB output (local execution only)"
    fi

    # Add script path
    k6_args+=("$SCRIPT_PATH")

    # Set current test info for cleanup
    CURRENT_SCENARIO="$scenario"
    CURRENT_PROFILE="$profile"

    # Run the test
    local start_time=$(date +%s)
    local exit_code=0

    # Build environment for k6 with metric optimization
    local -a env_vars=(
        PRIVATE_KEY="$PRIVATE_KEY"
        WALLET_ADDRESS="$WALLET_ADDRESS"
        K6_NO_THRESHOLDS="true"
        K6_NO_SUMMARY="true"
        RPC_URLS="$RPC_URLS_STR"
        SCENARIO_TYPE="$scenario"
        LOAD_PROFILE="$profile"
        PER_RPC_VU="$PER_RPC_VU"
    )

    # Add InfluxDB variables only if using InfluxDB
    if [[ "${USE_INFLUXDB:-1}" == "1" ]]; then
        env_vars+=(
            INFLUXDB="$INFLUXDB"
            K6_INFLUXDB_TOKEN="$K6_INFLUXDB_TOKEN"
            K6_INFLUXDB_ORGANIZATION="$K6_INFLUXDB_ORGANIZATION"
            K6_INFLUXDB_BUCKET="$K6_INFLUXDB_BUCKET"
            K6_TAGS_AS_FIELDS="vu:int,iter:int"
        )
    fi

    # Add optional variables
    [[ -n "${CONTRACT_ADDRESS:-}" ]] && env_vars+=(CONTRACT_ADDRESS="$CONTRACT_ADDRESS")
    [[ -n "${TEST_ADDRESS:-}" ]] && env_vars+=(TEST_ADDRESS="$TEST_ADDRESS")
    [[ -n "${ERC20_TOKEN:-}" ]] && env_vars+=(ERC20_TOKEN="$ERC20_TOKEN")
    [[ -n "${SUB_ID:-}" ]] && env_vars+=(SUB_ID="$SUB_ID")
    [[ -n "${TX_HASH:-}" ]] && env_vars+=(TX_HASH="$TX_HASH")
    [[ -n "${EST_DATA:-}" ]] && env_vars+=(EST_DATA="$EST_DATA")
    [[ -n "${EST_CONTRACT:-}" ]] && env_vars+=(EST_CONTRACT="$EST_CONTRACT")
    [[ -n "${EST_VALUE:-}" ]] && env_vars+=(EST_VALUE="$EST_VALUE")
    [[ -n "${START_BLOCK:-}" ]] && env_vars+=(START_BLOCK="$START_BLOCK")
    [[ -n "${END_BLOCK:-}" ]] && env_vars+=(END_BLOCK="$END_BLOCK")

    # Run k6 with environment
    env "${env_vars[@]}" "$K6_BIN" "${k6_args[@]}" 2>&1 | tee -a "$LOG_FILE" || exit_code=$?

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    if [[ $exit_code -eq 0 ]]; then
        log_success "Test completed: $scenario @ $profile (${duration}s)"
    else
        log_error "Test failed: $scenario @ $profile (exit code: $exit_code, duration: ${duration}s)"
        log_error "Check the log file for details: $LOG_FILE"
    fi

    # Process results
    process_test_results "$run_id" "$scenario" "$profile" "$exit_code" "$duration"

    return $exit_code
}

process_test_results() {
    local run_id="$1"
    local scenario="$2"
    local profile="$3"
    local exit_code="$4"
    local duration="$5"

    # Create result summary
    local result_file="$RESULTS_DIR/${run_id}_summary.json"

    # Use portable date command
    local timestamp
    if date -u +%Y-%m-%dT%H:%M:%SZ >/dev/null 2>&1; then
        timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    else
        # Fallback for systems without -u flag
        timestamp=$(date +%Y-%m-%dT%H:%M:%SZ)
    fi

    # Add influxdb_enabled field to track if metrics were stored
    cat > "$result_file" << EOF
{
    "run_id": "$run_id",
    "scenario": "$scenario",
    "profile": "$profile",
    "exit_code": $exit_code,
    "duration_seconds": $duration,
    "timestamp": "$timestamp",
    "influxdb_enabled": ${USE_INFLUXDB:-1},
    "environment": {
        "k6_binary": "$K6_BIN",
        "script": "$SCRIPT_PATH",
        "influxdb_bucket": "${K6_INFLUXDB_BUCKET:-null}"
    }
}
EOF

    log_debug "Test results saved to $result_file"
}

###############################################################################
# 12. Main execution flow
###############################################################################
print_usage() {
    cat << EOF
Usage: $SCRIPT_NAME [OPTIONS]

Enhanced k6 RPC load test orchestrator with advanced monitoring and control.

OPTIONS:
    -h          Show this help message
    -d          Enable debug mode
    -v          Enable verbose output
    -n          Non-interactive mode (use defaults)
    -s SCENARIO Filter to specific scenario
    -p PROFILE  Filter to specific profile
    -u URL      RPC URL(s) to use (comma-separated)
    -r STATE    Resume from saved state file
    -i          Disable InfluxDB output (local execution only)
    -I          Enable InfluxDB output (default)

EXAMPLES:
    $SCRIPT_NAME                    # Interactive mode with InfluxDB
    $SCRIPT_NAME -i                 # Interactive mode without InfluxDB
    $SCRIPT_NAME -n                 # Non-interactive mode (use defaults)
    $SCRIPT_NAME -n -i              # Non-interactive without InfluxDB
    $SCRIPT_NAME -s S1_BlockNumber  # Run specific scenario
    $SCRIPT_NAME -p baseline        # Run specific profile
    $SCRIPT_NAME -n -s S1_BlockNumber -p baseline  # Non-interactive with filters
    $SCRIPT_NAME -n -u https://rpc.example.com  # Non-interactive with custom RPC
    $SCRIPT_NAME -d                 # Debug mode

ENVIRONMENT:
    ENV_FILE         Path to environment file (default: .k6_env)
    CONFIG_DIR       Configuration directory (default: ./perf/config)
    LOG_DIR          Log directory (default: ./logs)
    RESULTS_DIR      Results directory (default: ./results)
    USE_INFLUXDB     Enable/disable InfluxDB (0=disabled, 1=enabled)
    NO_INFLUXDB      Alternative way to disable InfluxDB

INFLUXDB CONTROL:
    - Use -i flag to disable InfluxDB output
    - Use -I flag to enable InfluxDB output (default)
    - Set USE_INFLUXDB=0 or NO_INFLUXDB=1 to disable
    - When disabled, tests run locally without storing metrics

EOF
    exit 0
}

main() {
    local SCENARIO_FILTER=""
    local PROFILE_FILTER=""
    local RPC_URLS_PARAM=""
    local RESUME_FROM=""
    local DEBUG=0
    local VERBOSE=0
    local NON_INTERACTIVE=0

    # Initialize USE_INFLUXDB based on environment
    # Priority: NO_INFLUXDB env var > USE_INFLUXDB env var > default (1)
    if [[ "${NO_INFLUXDB:-0}" == "1" ]]; then
        USE_INFLUXDB=0
    else
        USE_INFLUXDB="${USE_INFLUXDB:-1}"
    fi

    # Parse options using getopts
    while getopts ":hdvniIs:p:u:r:" opt; do
        case $opt in
            h) print_usage ;;
            d) DEBUG=1 ;;
            v) VERBOSE=1 ;;
            n) NON_INTERACTIVE=1 ;;
            i) USE_INFLUXDB=0 ;;  # Disable InfluxDB
            I) USE_INFLUXDB=1 ;;  # Enable InfluxDB (explicit)
            s) SCENARIO_FILTER="$OPTARG" ;;
            p) PROFILE_FILTER="$OPTARG" ;;
            u) RPC_URLS_PARAM="$OPTARG" ;;
            r) RESUME_FROM="$OPTARG" ;;
            \?) log_error "Invalid option: -$OPTARG"; print_usage ;;
            :) log_error "Option -$OPTARG requires an argument"; print_usage ;;
        esac
    done

    # Export USE_INFLUXDB for child processes
    export USE_INFLUXDB

    # Handle OPTIND portably
    if [[ -n "${BASH_VERSION:-}" ]]; then
        shift $((OPTIND-1))
    else
        # zsh
        shift $((OPTIND-1)) 2>/dev/null || shift $(($OPTIND-1))
    fi

    # Enable debug mode if requested
    [[ $DEBUG -eq 1 ]] && set -x

    # Initialize environment
    init_environment

    # Log InfluxDB mode
    if [[ "$USE_INFLUXDB" == "1" ]]; then
        log_info "InfluxDB output is ENABLED"
    else
        log_warn "InfluxDB output is DISABLED - running in local mode only"
    fi

    # Acquire lock
    if ! acquire_lock; then
        log_error "Another instance is already running"
        exit 1
    fi

    # Validate environment
    if ! validate_environment; then
        log_error "Environment validation failed - cannot proceed"
        log_error "Please check the errors above and ensure:"
        log_error "  1. k6 binary exists (./k6 or system k6)"
        log_error "  2. Required tools (jq, curl) are installed"
        log_error "  3. k6 script exists at: $SCRIPT_DIR/perf/somnia_rpc_perf.js"
        exit 1
    fi

    # Start resource monitoring
    if [[ $VERBOSE -eq 1 ]]; then
        start_monitoring
    fi

    # Default values from original script
    DEFAULT_RPCS=(
        "https://api.infra.mainnet.somnia.network/"
        "https://somnia-testnet.api.bharvest.dev/kurudeadbeef1234/"
    )

    DEFAULT_PROFILES=(
        baseline spike_200 ramp_find_max break_steady spike_10k spike_20k
        spike_30k spike_28k spike_25k spike_24k spike_26k spike_15k spike_13k
        spike_5k steady_900 steady_1k steady_20k steady_5k steady_10k steady_12k
        steady_17k steady_15k steady_50 steady_13k steady_14k
    )

    DEFAULT_SCENARIOS=(
        S1_BlockNumber S2_ChainId S3_GetBalance S4_GetCode
        S5_EthCallSimple S6_EthCallHeavy S7_GetLogsSmall S8_GetLogsRange
        S9_GetBlockLight S10_GetBlockFull S11_SendRawTxSmall S12_SendRawTxERC20
        S13_PendingTxSub S14_NewHeadSub S15_LogsSubFilter S16_UnsubscribeWS
        S17_EstimateGas S18_GetTxReceipt S19_BatchCalls S20_HttpHandshake
    )

    # Interactive prompts for required variables (skip in non-interactive mode)
    if [[ $NON_INTERACTIVE -eq 0 ]]; then
        if ! ask_reuse PRIVATE_KEY "PRIVATE_KEY"; then
            prompt_secret PRIVATE_KEY "Enter PRIVATE_KEY (hex, no 0x)"
        fi

        if ! ask_reuse WALLET_ADDRESS "WALLET_ADDRESS"; then
            prompt_plain WALLET_ADDRESS "Enter WALLET_ADDRESS (0x…)"
        fi

        # Only prompt for InfluxDB settings if enabled
        if [[ "$USE_INFLUXDB" == "1" ]]; then
            if ! ask_reuse INFLUXDB "INFLUXDB URL"; then
                prompt_plain INFLUXDB "Enter INFLUXDB URL (http://host:8086)"
            fi

            if ! ask_reuse K6_INFLUXDB_TOKEN "K6_INFLUXDB_TOKEN"; then
                prompt_secret K6_INFLUXDB_TOKEN "Enter K6 InfluxDB token"
            fi

            if ! ask_reuse K6_INFLUXDB_ORGANIZATION "K6_INFLUXDB_ORGANIZATION"; then
                prompt_plain K6_INFLUXDB_ORGANIZATION "Enter K6 InfluxDB organization"
            fi

            if ! ask_reuse K6_INFLUXDB_BUCKET "K6_INFLUXDB_BUCKET"; then
                prompt_plain K6_INFLUXDB_BUCKET "Enter K6 InfluxDB bucket"
            fi
        else
            log_info "Skipping InfluxDB configuration (output disabled)"
        fi
    else
        log_info "Non-interactive mode: Using environment variables from .k6_env"
    fi

    # Check InfluxDB connection only if enabled
    if [[ "$USE_INFLUXDB" == "1" ]]; then
        if ! check_influxdb_connection; then
            if [[ $NON_INTERACTIVE -eq 1 ]]; then
                log_warn "InfluxDB connection check failed. Continuing in non-interactive mode."
            else
                log_warn "InfluxDB connection check failed. Continue anyway? (y/N)"
                read -r ans
                [[ ! $ans =~ ^[Yy]$ ]] && exit 1
            fi
        fi

        # Setup k6 output configuration with much smaller batch size to prevent 311MB requests
        K6_OUT_DSN="xk6-influxdb=${INFLUXDB}?org=${K6_INFLUXDB_ORGANIZATION}&bucket=${K6_INFLUXDB_BUCKET}&token=${K6_INFLUXDB_TOKEN}&httpWriteTimeout=30s&httpPushInterval=1s&httpBatchSize=100&metricsFlusherQueueSize=10000&concurrentWrites=4"
        K6_OUT_ARG=(-o "$K6_OUT_DSN")
        log_success "Using xk6-influxdb output → $INFLUXDB (${K6_INFLUXDB_BUCKET})"
    else
        # Clear any existing output args
        unset K6_OUT_ARG
        log_info "Running tests locally without InfluxDB output"
    fi

    # RPC endpoints selection
    if [[ -n "$RPC_URLS_PARAM" ]]; then
        # Use RPC URLs from command line parameter
        IFS=',' read -r -a RPCS <<< "${RPC_URLS_PARAM// /}"
        log_info "Using RPC endpoints from command line: ${RPCS[*]}"
    elif [[ $NON_INTERACTIVE -eq 1 ]]; then
        log_info "Non-interactive mode: Using default RPC endpoints"
        RPCS=("${DEFAULT_RPCS[@]}")
    else
        read -rp $'\nRPC endpoints (comma-separated, Enter=defaults): ' RPC_INPUT
        if [[ -z $RPC_INPUT ]]; then
            RPCS=("${DEFAULT_RPCS[@]}")
        else
            IFS=',' read -r -a RPCS <<< "${RPC_INPUT// /}"
        fi
    fi

    # Validate RPC endpoints
    for rpc in "${RPCS[@]}"; do
        if ! validate_url "$rpc"; then
            exit 1
        fi
    done

    # Profile and scenario selection
    if [[ -n "$PROFILE_FILTER" ]]; then
        PROFILES=("$PROFILE_FILTER")
    elif [[ $NON_INTERACTIVE -eq 1 ]]; then
        log_info "Non-interactive mode: Using baseline profile"
        PROFILES=("baseline")
    else
        choose_multi DEFAULT_PROFILES "Load profiles"
        PROFILES=("${SEL[@]}")
    fi

    if [[ -n "$SCENARIO_FILTER" ]]; then
        SCENARIOS=("$SCENARIO_FILTER")
    elif [[ $NON_INTERACTIVE -eq 1 ]]; then
        log_info "Non-interactive mode: Using S1_BlockNumber scenario"
        SCENARIOS=("S1_BlockNumber")
    else
        choose_multi DEFAULT_SCENARIOS "Scenarios"
        SCENARIOS=("${SEL[@]}")
    fi

    # VUs per RPC configuration
    if [[ $NON_INTERACTIVE -eq 1 ]]; then
        log_info "Non-interactive mode: Using 1 VU per RPC endpoint"
        PER_RPC_VU=1
    else
        read -rp $'\nVUs per RPC endpoint [default 1]: ' tmp
        PER_RPC_VU="${tmp:-1}"
    fi

    if ! validate_numeric "$PER_RPC_VU" "VUs per RPC" 1 1000; then
        exit 1
    fi

    RPC_URLS_STR=$(IFS=,; echo "${RPCS[*]}")

    # Sleep configurations
    SLEEP_PROFILES="${SLEEP_PROFILES:-300}"
    SLEEP_SCENARIOS="${SLEEP_SCENARIOS:-600}"

    # Main execution loop
    log_info "DEBUG: Checking arrays..."
    log_debug "SCENARIOS array size: ${#SCENARIOS[@]}"
    log_debug "PROFILES array size: ${#PROFILES[@]}"

    # Check if arrays are properly populated
    if [[ ${#SCENARIOS[@]} -eq 0 ]]; then
        log_error "No scenarios selected!"
        exit 1
    fi

    if [[ ${#PROFILES[@]} -eq 0 ]]; then
        log_error "No profiles selected!"
        exit 1
    fi

    log_info "DEBUG: Arrays validated successfully"

    local total_tests=$((${#SCENARIOS[@]} * ${#PROFILES[@]}))
    local current_test=0

    log_info "Starting test execution: ${#SCENARIOS[@]} scenarios × ${#PROFILES[@]} profiles = $total_tests tests"
    log_debug "Scenarios selected: ${SCENARIOS[*]}"
    log_debug "Profiles selected: ${PROFILES[*]}"
    log_debug "RPC URLs: $RPC_URLS_STR"

    # Show InfluxDB status in summary
    if [[ "$USE_INFLUXDB" == "1" ]]; then
        log_info "Metrics storage: InfluxDB enabled → ${K6_INFLUXDB_BUCKET:-unknown}"
    else
        log_warn "Metrics storage: DISABLED (local execution only)"
    fi

    for scenario in "${SCENARIOS[@]}"; do
        log_debug "Processing scenario: $scenario"
        if ! scenario_prepare "$scenario"; then
            log_warn "Skipping $scenario (required variable not provided)"
            continue
        fi

        for profile in "${PROFILES[@]}"; do
            log_debug "About to increment current_test: $current_test"
            current_test=$((current_test + 1))
            log_debug "After increment current_test: $current_test"

            printf '\n%s▶ [%d/%d] %s | %s%s\n' \
                "$BOLD$CYAN" "$current_test" "$total_tests" \
                "$scenario" "$profile" "$RESET"

            RUN_ID="run_$(date +%Y%m%d_%H%M%S)_${scenario}_${profile}"

            if run_k6_test "$scenario" "$profile" "$RUN_ID"; then
                log_success "Finished $scenario @ $profile"
            else
                log_error "Failed $scenario @ $profile"
                # Ask whether to continue (skip in non-interactive mode)
                if [[ $NON_INTERACTIVE -eq 0 ]]; then
                    read -rp "Continue with remaining tests? (Y/n): " ans
                    [[ $ans =~ ^[Nn]$ ]] && exit 1
                else
                    log_warn "Test failed in non-interactive mode, continuing..."
                fi
            fi

            if [[ $current_test -lt $total_tests ]]; then
                log_info "Sleeping ${SLEEP_PROFILES}s before next profile..."
                sleep "$SLEEP_PROFILES"
            fi
        done

        if [[ $scenario != "${SCENARIOS[-1]}" ]]; then
            log_info "Waiting ${SLEEP_SCENARIOS}s before next scenario group..."
            sleep "$SLEEP_SCENARIOS"
        fi
    done

    log_success "All scenario × profile runs completed!"

    # Different completion message based on InfluxDB usage
    if [[ "$USE_INFLUXDB" == "1" ]]; then
        log_info "Check your Grafana/InfluxDB dashboards for results"
    else
        log_info "Test results saved locally in: $RESULTS_DIR"
        log_info "Test logs available in: $LOG_FILE"
    fi

    log_info "Your variables are saved in '$ENV_FILE' and will auto-load next time"
}

# Execute main function
main "$@"