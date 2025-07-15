/**
 * Configuration Loader Module
 * 
 * Loads and manages configuration from JSON files
 * Provides centralized access to all configuration settings
 */

import { open } from 'k6/experimental/fs';

// Configuration file paths
const CONFIG_DIR = './config/';
const CONFIG_FILES = {
    rpc: 'rpc-config.json',
    loadProfiles: 'load-profiles.json',
    scenarios: 'scenarios-config.json',
    metrics: 'metrics-config.json',
    environment: 'environment.json'
};

/**
 * Load JSON configuration file
 * @param {string} filename - Configuration file name
 * @returns {object} Parsed configuration object
 */
function loadConfig(filename) {
    try {
        const filepath = CONFIG_DIR + filename;
        const file = open(filepath);
        const content = file.read();
        file.close();
        return JSON.parse(content);
    } catch (error) {
        console.error(`Failed to load config file ${filename}: ${error.message}`);
        throw error;
    }
}

/**
 * Configuration Manager Class
 */
export class ConfigManager {
    constructor() {
        this.rpcConfig = null;
        this.loadProfiles = null;
        this.scenarios = null;
        this.metrics = null;
        this.environment = null;
        this.loaded = false;
    }

    /**
     * Load all configuration files
     */
    loadAll() {
        if (this.loaded) return;
        
        console.log('Loading configuration files...');
        this.rpcConfig = loadConfig(CONFIG_FILES.rpc);
        this.loadProfiles = loadConfig(CONFIG_FILES.loadProfiles);
        this.scenarios = loadConfig(CONFIG_FILES.scenarios);
        this.metrics = loadConfig(CONFIG_FILES.metrics);
        this.environment = loadConfig(CONFIG_FILES.environment);
        this.loaded = true;
        console.log('Configuration loaded successfully');
    }

    /**
     * Get RPC configuration
     */
    getRpcConfig() {
        if (!this.loaded) this.loadAll();
        return this.rpcConfig;
    }

    /**
     * Get load profile by name
     * @param {string} profileName - Profile name
     * @returns {object} Load profile configuration
     */
    getLoadProfile(profileName) {
        if (!this.loaded) this.loadAll();
        const profile = this.loadProfiles.profiles[profileName];
        if (!profile) {
            throw new Error(`Unknown load profile: ${profileName}`);
        }
        return profile;
    }

    /**
     * Get scenario configuration
     * @param {string} scenarioName - Scenario name
     * @returns {object} Scenario configuration
     */
    getScenario(scenarioName) {
        if (!this.loaded) this.loadAll();
        const scenario = this.scenarios.scenarios[scenarioName];
        if (!scenario) {
            throw new Error(`Unknown scenario: ${scenarioName}`);
        }
        return scenario;
    }

    /**
     * Get all metrics configuration
     */
    getMetricsConfig() {
        if (!this.loaded) this.loadAll();
        return this.metrics;
    }

    /**
     * Get environment configuration
     */
    getEnvironment() {
        if (!this.loaded) this.loadAll();
        return this.environment;
    }

    /**
     * Get chain ID from RPC config
     */
    getChainId() {
        if (!this.loaded) this.loadAll();
        return this.rpcConfig.blockchain.chainId;
    }

    /**
     * Get contract addresses
     */
    getContracts() {
        if (!this.loaded) this.loadAll();
        return this.rpcConfig.contracts;
    }

    /**
     * Get performance settings
     */
    getPerformanceSettings() {
        if (!this.loaded) this.loadAll();
        return this.rpcConfig.performance;
    }

    /**
     * Get validation settings
     */
    getValidationSettings() {
        if (!this.loaded) this.loadAll();
        return this.rpcConfig.validation;
    }

    /**
     * Build k6 load profile configuration
     * @param {string} profileName - Profile name
     * @param {number} baseVus - Base number of VUs
     * @returns {object} k6 executor configuration
     */
    buildK6Profile(profileName, baseVus) {
        const profile = this.getLoadProfile(profileName);
        const config = {
            executor: profile.executor
        };

        // Handle different executor types
        switch (profile.executor) {
            case 'constant-vus':
                config.vus = baseVus * (profile.vusMultiplier || 1);
                config.duration = profile.duration;
                break;
                
            case 'constant-arrival-rate':
                config.rate = profile.rate;
                config.timeUnit = profile.timeUnit;
                config.duration = profile.duration;
                config.preAllocatedVUs = Math.max(
                    profile.minPreAllocatedVUs || 0,
                    baseVus * (profile.preAllocatedVUsMultiplier || 1)
                );
                break;
                
            case 'ramping-arrival-rate':
                config.timeUnit = profile.timeUnit;
                config.preAllocatedVUs = Math.max(
                    profile.minPreAllocatedVUs || 0,
                    baseVus * (profile.preAllocatedVUsMultiplier || 1)
                );
                config.stages = profile.stages;
                break;
                
            case 'externally-controlled':
                config.vus = Math.max(
                    profile.minVUs || 0,
                    baseVus * (profile.vusMultiplier || 1)
                );
                config.maxVUs = Math.max(
                    profile.minMaxVUs || 0,
                    baseVus * (profile.maxVUsMultiplier || 1)
                );
                break;
        }

        // Add optional fields
        if (profile.gracefulStop) {
            config.gracefulStop = profile.gracefulStop;
        }

        return config;
    }

    /**
     * Check if scenario requires specific resources
     * @param {string} scenarioName - Scenario name
     * @returns {object} Resource requirements
     */
    getScenarioRequirements(scenarioName) {
        const scenario = this.getScenario(scenarioName);
        return {
            requiresWallet: scenario.requiresWallet || false,
            requiresContract: scenario.requiresContract || false,
            requiresERC20: scenario.requiresERC20 || false,
            requiresTxHash: scenario.requiresTxHash || false,
            transport: scenario.transport || 'http'
        };
    }

    /**
     * Get write scenarios list
     * @returns {array} List of write scenario names
     */
    getWriteScenarios() {
        if (!this.loaded) this.loadAll();
        return Object.entries(this.scenarios.scenarios)
            .filter(([_, config]) => config.category === 'transactions')
            .map(([name, _]) => name);
    }
}

// Export singleton instance
export const configManager = new ConfigManager();