"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const grpc = __importStar(require("@grpc/grpc-js"));
const fabric_gateway_1 = require("@hyperledger/fabric-gateway");
const crypto = __importStar(require("crypto"));
const fs_1 = require("fs");
const path = __importStar(require("path"));
const channelName = envOrDefault('CHANNEL_NAME', 'mychannel');
const chaincodeName = envOrDefault('CHAINCODE_NAME', 'agri');
const mspId = envOrDefault('MSP_ID', 'Org1MSP');
const sensorId = envOrDefault('SENSOR_ID', 'CAY_01');
const mockIntervalMs = Number(envOrDefault('MOCK_INTERVAL_MS', '5000'));
const statuses = ['Tuoi', 'Heo nhe', 'Heo'];
const appGatewayRoot = path.basename(__dirname) === 'dist' ? path.resolve(__dirname, '..') : __dirname;
const blockchainLeafRoot = path.resolve(appGatewayRoot, '..');
const cryptoPath = envOrDefault('CRYPTO_PATH', path.resolve(blockchainLeafRoot, 'test-network', 'organizations', 'peerOrganizations', 'org1.example.com'));
const keyDirectoryPath = envOrDefault('KEY_DIRECTORY_PATH', path.resolve(cryptoPath, 'users', 'User1@org1.example.com', 'msp', 'keystore'));
const certDirectoryPath = envOrDefault('CERT_DIRECTORY_PATH', path.resolve(cryptoPath, 'users', 'User1@org1.example.com', 'msp', 'signcerts'));
const tlsCertPath = envOrDefault('TLS_CERT_PATH', path.resolve(cryptoPath, 'peers', 'peer0.org1.example.com', 'tls', 'ca.crt'));
const peerEndpoint = envOrDefault('PEER_ENDPOINT', 'localhost:7051');
const peerHostAlias = envOrDefault('PEER_HOST_ALIAS', 'peer0.org1.example.com');
async function main() {
    displayInputParameters();
    const client = await newGrpcConnection();
    const gateway = (0, fabric_gateway_1.connect)({
        client,
        identity: await newIdentity(),
        signer: await newSigner(),
        hash: fabric_gateway_1.hash.sha256,
        evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
        endorseOptions: () => ({ deadline: Date.now() + 15000 }),
        submitOptions: () => ({ deadline: Date.now() + 5000 }),
        commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
    });
    const network = gateway.getNetwork(channelName);
    const contract = network.getContract(chaincodeName);
    await startMockGenerator(contract, gateway, client);
}
main().catch((error) => {
    console.error('FAILED to run gateway backend:', error);
    process.exitCode = 1;
});
async function startMockGenerator(contract, gateway, client) {
    console.log(`Mock Data Generator started: sensor=${sensorId}, interval=${mockIntervalMs}ms`);
    const stop = () => {
        console.log('Shutting down gateway backend...');
        gateway.close();
        client.close();
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    const submitMockRecord = async () => {
        const payload = {
            id: sensorId,
            do_am: randomInt(40, 80),
            tinh_trang: statuses[randomInt(0, statuses.length - 1)] ?? statuses[0],
            timestamp: new Date().toISOString(),
        };
        console.log('Submitting CreateRecord payload:', payload);
        await contract.submitTransaction('CreateRecord', payload.id, String(payload.do_am), payload.tinh_trang, payload.timestamp);
        console.log('Transaction committed:', payload.timestamp);
    };
    await submitMockRecord();
    setInterval(() => {
        submitMockRecord().catch((error) => {
            console.error('submitTransaction(CreateRecord) failed:', error);
        });
    }, mockIntervalMs);
}
async function newGrpcConnection() {
    const tlsRootCert = await fs_1.promises.readFile(tlsCertPath);
    const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);
    return new grpc.Client(peerEndpoint, tlsCredentials, {
        'grpc.ssl_target_name_override': peerHostAlias,
    });
}
async function newIdentity() {
    const certPath = await getFirstDirFileName(certDirectoryPath);
    const credentials = await fs_1.promises.readFile(certPath);
    return { mspId, credentials };
}
async function newSigner() {
    const keyPath = await getFirstDirFileName(keyDirectoryPath);
    const privateKeyPem = await fs_1.promises.readFile(keyPath);
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    return fabric_gateway_1.signers.newPrivateKeySigner(privateKey);
}
async function getFirstDirFileName(dirPath) {
    const files = await fs_1.promises.readdir(dirPath);
    const file = files[0];
    if (!file) {
        throw new Error(`No files in directory: ${dirPath}`);
    }
    return path.join(dirPath, file);
}
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
function envOrDefault(key, defaultValue) {
    return process.env[key] || defaultValue;
}
function displayInputParameters() {
    console.log(`channelName:       ${channelName}`);
    console.log(`chaincodeName:     ${chaincodeName}`);
    console.log(`mspId:             ${mspId}`);
    console.log(`sensorId:          ${sensorId}`);
    console.log(`mockIntervalMs:    ${mockIntervalMs}`);
    console.log(`cryptoPath:        ${cryptoPath}`);
    console.log(`keyDirectoryPath:  ${keyDirectoryPath}`);
    console.log(`certDirectoryPath: ${certDirectoryPath}`);
    console.log(`tlsCertPath:       ${tlsCertPath}`);
    console.log(`peerEndpoint:      ${peerEndpoint}`);
    console.log(`peerHostAlias:     ${peerHostAlias}`);
}
