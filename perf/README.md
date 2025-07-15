# Modular k6 Ethereum RPC Performance Testing

This directory contains a modularized version of the k6 Ethereum RPC performance testing script with configuration externalized to JSON files for better maintainability and flexibility.

## Directory Structure

```
perf/
├── config/                      # Configuration files
│   ├── rpc-config.json         # RPC and blockchain settings
│   ├── load-profiles.json      # Load testing profiles
│   ├── scenarios-config.json   # Test scenario definitions
│   ├── metrics-config.json     # Metrics configuration
│   └── environment.json        # Environment defaults
├── lib/                        # Modular libraries
│   ├── config-loader.js        # Configuration management
│   ├── metrics.js              # Metrics handling
│   ├── rpc-client.js           # JSON-RPC client
│   ├── websocket-client.js     # WebSocket client
│   └── wallet-manager.js       # Wallet operations
├── somnia_rpc_perf.js          # Original monolithic script
└── somnia_rpc_perf_modular.js  # New modular script
```

## Configuration Files

### 1. `rpc-config.json`
Contains blockchain, contract, token, and performance settings:
- Chain ID and gas settings
- Contract addresses and function signatures
- Token decimals and amounts
- Retry logic and timeout configurations
- Validation thresholds

### 2. `load-profiles.json`
Defines various load testing profiles:
- `baseline`: Basic functionality testing
- `spike_*`: Spike load tests at various RPS levels
- `steady_*`: Sustained load tests
- `ramp_*`: Gradual load increase/decrease
- `soak_*`: Long-duration stability tests
- `stress_*`: High-load stress tests

### 3. `scenarios-config.json`
Defines all 20 test scenarios with:
- Scenario metadata and descriptions
- RPC method configurations
- Validation rules
- Resource requirements
- Category groupings

### 4. `metrics-config.json`
Configures k6 metrics:
- Trend metrics (latencies)
- Counter metrics (success/errors)
- Rate metrics (error rates)
- Gauge metrics (real-time values)
- Metric tags and thresholds

### 5. `environment.json`
Default environment settings:
- Default scenario and profile
- Timeout configurations
- Delay settings
- Test metadata

## Module Libraries

### 1. `config-loader.js`
Central configuration management:
- Loads all JSON config files
- Provides typed access to settings
- Builds k6 executor configurations
- Validates scenario requirements

### 2. `metrics.js`
Metrics handling:
- Creates and manages k6 metrics
- Provides helper functions for recording
- Structured error logging
- State metric updates

### 3. `rpc-client.js`
JSON-RPC client with:
- Retry logic
- Comprehensive error handling
- Request/response validation
- Performance tracking

### 4. `websocket-client.js`
WebSocket subscription handling:
- Connection management
- Subscription lifecycle
- Error recovery
- Metrics integration

### 5. `wallet-manager.js`
Wallet operations:
- Wallet generation
- Transaction building and signing
- Batch funding operations
- ERC20 token distribution

## Usage

### Running with the Modular Script

```bash
# Use the same environment variables as before
export RPC_URLS="https://rpc1.example.com,https://rpc2.example.com"
export SCENARIO_TYPE="S1_BlockNumber"
export LOAD_PROFILE="baseline"

# Run with the modular script
k6 run somnia_rpc_perf_modular.js
```

### Customizing Configuration

1. **Modify JSON files** in the `config/` directory
2. **No code changes required** for most configuration updates
3. **Add new scenarios** by updating `scenarios-config.json`
4. **Create new load profiles** in `load-profiles.json`

### Environment Variables

All original environment variables are still supported:
- `RPC_URLS`: Comma-separated RPC endpoints (required)
- `SCENARIO_TYPE`: Test scenario (default: S1_BlockNumber)
- `LOAD_PROFILE`: Load profile (default: baseline)
- `PRIVATE_KEY`: Base wallet private key (for write scenarios)
- `WALLET_ADDRESS`: Base wallet address (for write scenarios)
- `CONTRACT_ADDRESS`: Smart contract address
- `CHAIN_ID`: Blockchain chain ID
- And many more...

### Benefits of Modular Approach

1. **Separation of Concerns**: Configuration separated from logic
2. **Easy Maintenance**: Update settings without touching code
3. **Version Control**: Track configuration changes separately
4. **Reusability**: Share modules across different test scripts
5. **Testability**: Each module can be tested independently
6. **Flexibility**: Mix and match configurations easily

## Migration from Original Script

The modular script (`somnia_rpc_perf_modular.js`) is fully compatible with the original script's environment variables and behavior. You can:

1. **Use it as a drop-in replacement** for the original script
2. **Gradually migrate** by using the modular version for new tests
3. **Customize configurations** without modifying the script

## Adding New Features

### Adding a New Scenario

1. Edit `config/scenarios-config.json`
2. Add scenario definition with validation rules
3. Implement scenario logic in main script if needed

### Adding a New Load Profile

1. Edit `config/load-profiles.json`
2. Define executor configuration
3. No code changes required

### Adding New Metrics

1. Edit `config/metrics-config.json`
2. Update `lib/metrics.js` to create the metric
3. Use the metric in your scenario logic

## Troubleshooting

- **Configuration not loading**: Check file paths and JSON syntax
- **Module import errors**: Ensure all files are in correct directories
- **Validation failures**: Check scenario requirements in config
- **Performance issues**: Adjust batch sizes and delays in config