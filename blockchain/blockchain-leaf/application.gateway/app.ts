import * as grpc from '@grpc/grpc-js';
import { connect, Contract, Gateway, hash, Identity, Signer, signers } from '@hyperledger/fabric-gateway';
import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import express from 'express';
import cors from 'cors';

const channelName = envOrDefault('CHANNEL_NAME', 'mychannel');
const chaincodeName = envOrDefault('CHAINCODE_NAME', 'agri');
const mspId = envOrDefault('MSP_ID', 'Org1MSP');

const appGatewayRoot = path.basename(__dirname) === 'dist' ? path.resolve(__dirname, '..') : __dirname;
const blockchainLeafRoot = path.resolve(appGatewayRoot, '..');

const cryptoPath = envOrDefault(
    'CRYPTO_PATH',
    path.resolve(blockchainLeafRoot, 'test-network', 'organizations', 'peerOrganizations', 'org1.example.com'),
);
const keyDirectoryPath = envOrDefault(
    'KEY_DIRECTORY_PATH',
    path.resolve(cryptoPath, 'users', 'User1@org1.example.com', 'msp', 'keystore'),
);
const certDirectoryPath = envOrDefault(
    'CERT_DIRECTORY_PATH',
    path.resolve(cryptoPath, 'users', 'User1@org1.example.com', 'msp', 'signcerts'),
);
const tlsCertPath = envOrDefault(
    'TLS_CERT_PATH',
    path.resolve(cryptoPath, 'peers', 'peer0.org1.example.com', 'tls', 'ca.crt'),
);
const peerEndpoint = envOrDefault('PEER_ENDPOINT', 'localhost:7051');
const peerHostAlias = envOrDefault('PEER_HOST_ALIAS', 'peer0.org1.example.com');

async function main(): Promise<void> {
    displayInputParameters();

    const client = await newGrpcConnection();
    const gateway = connect({
        client,
        identity: await newIdentity(),
        signer: await newSigner(),
        hash: hash.sha256,
        evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
        endorseOptions: () => ({ deadline: Date.now() + 15000 }),
        submitOptions: () => ({ deadline: Date.now() + 5000 }),
        commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
    });

    const network = gateway.getNetwork(channelName);
    const contract = network.getContract(chaincodeName);

    await startExpressServer(contract, gateway, client);
}

main().catch((error: unknown) => {
    console.error('FAILED to run gateway backend:', error);
    process.exitCode = 1;
});

async function startExpressServer(contract: Contract, gateway: Gateway, client: grpc.Client): Promise<void> {
    const app = express();
    app.use(cors());
    app.use(express.json());

    const port = process.env.PORT || 8080;

    app.post('/api/blockchain/record', async (req, res) => {
        try {
            const payload = req.body;
            if (!payload || !payload.tree_id) {
                res.status(400).json({ error: 'Missing tree_id in payload' });
                return;
            }
            const id = payload.tree_id;
            const payloadStr = JSON.stringify(payload);
            
            console.log(`Submitting CreateRecord for id: ${id}`);
            await contract.submitTransaction('CreateRecord', id, payloadStr);
            console.log(`Transaction committed for id: ${id}`);
            
            res.status(201).json({ success: true, message: 'Record saved to blockchain' });
        } catch (error) {
            console.error('Error in /api/blockchain/record:', error);
            res.status(500).json({ error: String(error) });
        }
    });

    app.get('/api/blockchain/history/:id', async (req, res) => {
        try {
            const id = req.params.id;
            console.log(`Evaluating GetHistory for id: ${id}`);
            const resultBytes = await contract.evaluateTransaction('GetHistory', id);
            const resultJson = Buffer.from(resultBytes).toString('utf8');
            res.status(200).json(JSON.parse(resultJson));
        } catch (error) {
            console.error('Error in /api/blockchain/history:', error);
            res.status(500).json({ error: String(error) });
        }
    });

    const server = app.listen(port, () => {
        console.log(`Blockchain Gateway API is running on port ${port}`);
    });

    const stop = (): void => {
        console.log('Shutting down gateway backend...');
        server.close();
        gateway.close();
        client.close();
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}

async function newGrpcConnection(): Promise<grpc.Client> {
    const tlsRootCert = await fs.readFile(tlsCertPath);
    const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);
    return new grpc.Client(peerEndpoint, tlsCredentials, {
        'grpc.ssl_target_name_override': peerHostAlias,
    });
}

async function newIdentity(): Promise<Identity> {
    const certPath = await getFirstDirFileName(certDirectoryPath);
    const credentials = await fs.readFile(certPath);
    return { mspId, credentials };
}

async function newSigner(): Promise<Signer> {
    const keyPath = await getFirstDirFileName(keyDirectoryPath);
    const privateKeyPem = await fs.readFile(keyPath);
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    return signers.newPrivateKeySigner(privateKey);
}

async function getFirstDirFileName(dirPath: string): Promise<string> {
    const files = await fs.readdir(dirPath);
    const file = files[0];
    if (!file) {
        throw new Error(`No files in directory: ${dirPath}`);
    }
    return path.join(dirPath, file);
}


function envOrDefault(key: string, defaultValue: string): string {
    return process.env[key] || defaultValue;
}

function displayInputParameters(): void {
    console.log(`channelName:       ${channelName}`);
    console.log(`chaincodeName:     ${chaincodeName}`);
    console.log(`mspId:             ${mspId}`);
    console.log(`cryptoPath:        ${cryptoPath}`);
    console.log(`keyDirectoryPath:  ${keyDirectoryPath}`);
    console.log(`certDirectoryPath: ${certDirectoryPath}`);
    console.log(`tlsCertPath:       ${tlsCertPath}`);
    console.log(`peerEndpoint:      ${peerEndpoint}`);
    console.log(`peerHostAlias:     ${peerHostAlias}`);
}
