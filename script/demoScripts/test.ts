import {
    getContract,
    parseUnits,
    Narrow,
    zeroAddress,
    bytesToHex
  } from 'viem'
  import { randomBytes } from 'crypto'
  import { config } from 'dotenv'
  import { ERC20__factory as ERC20 } from '../../typechain/factories/ERC20__factory'
  import { UnitFacet__factory as UnitFacet } from '../../typechain/factories/UnitFacet.sol/UnitFacet__factory'
  import { ensureBalance, ensureAllowance, executeTransaction, setupEnvironment, type SupportedChain } from './utils/demoScriptHelpers'
  
  config()
  
// Constants
  export const GUARDIAN_NODES = [
    {
      nodeId: 'unit-node',
      publicKey: '04dc6f89f921dc816aa69b687be1fcc3cc1d48912629abc2c9964e807422e1047e0435cb5ba0fa53cb9a57a9c610b4e872a0a2caedda78c4f85ebafcca93524061',
    },
    {
      nodeId: 'hl-node',
      publicKey: '048633ea6ab7e40cdacf37d1340057e84bb9810de0687af78d031e9b07b65ad4ab379180ab55075f5c2ebb96dab30d2c2fab49d5635845327b6a3c27d20ba4755b',
    },
    {
      nodeId: 'field-node',
      publicKey: '04ae2ab20787f816ea5d13f36c4c4f7e196e29e867086f3ce818abb73077a237f841b33ada5be71b83f4af29f333dedc5411ca4016bd52ab657db2896ef374ce99',
    },
  ];

  export const GUARDIAN_NODES_UNIT = {
    unitNode: GUARDIAN_NODES[0],
    hlNode: GUARDIAN_NODES[1],
    fieldNode: GUARDIAN_NODES[2],
  };
  
  const GUARDIAN_SIGNATURE_THRESHOLD = 2;
  
  
  interface Proposal {
    destinationAddress: string;
    destinationChain: string;
    asset: string;
    address: string;
    sourceChain: string;
    coinType?: string;
    keyType?: string;
  }
  
  interface VerificationResult {
    success: boolean;
    verifiedCount: number;
    errors?: string[];
    verificationDetails?: { [nodeId: string]: boolean };
  }
  
  function legacyProposalToPayload(nodeId: string, proposal: Proposal): Uint8Array {
    const payloadString = `${nodeId}:${[
      proposal.destinationAddress,
      proposal.destinationChain,
      proposal.asset,
      proposal.address,
      proposal.sourceChain,
      'deposit'
    ].join('-')}`;
    console.log("payloadString", payloadString);
    return new TextEncoder().encode(payloadString);
  }
  
  function newProposalToPayload(nodeId: string, proposal: Proposal): Uint8Array {
    console.log('nodeId', nodeId);
    console.log('proposal.coinType', proposal.coinType);
    console.log('proposal.destinationChain', proposal.destinationChain);
    console.log('proposal.destinationAddress', proposal.destinationAddress);
    console.log('proposal.address', proposal.address);
    const payloadString = `${nodeId}:${[
      'user',
      proposal.coinType,
      proposal.destinationChain,
      proposal.destinationAddress,
      proposal.address
    ].join('-')}`;
    return new TextEncoder().encode(payloadString);
  }
  
  function proposalToPayload(nodeId: string, proposal: Proposal): Uint8Array {
    if (proposal.coinType === 'ethereum') {
      return newProposalToPayload(nodeId, proposal);
    }
    
    return legacyProposalToPayload(nodeId, proposal);
  }

  function hexToBytes(hex: string): Uint8Array {
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
    return new Uint8Array(Buffer.from(cleanHex, 'hex'));
  }
  
async function processGuardianNodes(nodes: { nodeId: string; publicKey: string }[]) {
  const processed = [];
  for (const node of nodes) {
    try {
      const publicKeyBytes = hexToBytes(node.publicKey);
      if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 0x04) {
        throw new Error(`Invalid public key format for node ${node.nodeId}`);
      }
      const publicKey = await crypto.subtle.importKey(
        'raw',
        publicKeyBytes,
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['verify']
      );
      processed.push({ nodeId: node.nodeId, publicKey });
    } catch (error) {
      console.error(`Failed to process node ${node.nodeId}:`, error);
      throw new Error(`Node processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  return processed;
}
  
  async function verifySignature(publicKey: CryptoKey, message: Uint8Array, signature: string): Promise<boolean> {
    try {
      const sigBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
      if (sigBytes.length !== 64) {
        console.warn('Invalid signature length:', sigBytes.length);
        return false;
      }

      return await crypto.subtle.verify(
        {
          name: 'ECDSA',
          hash: { name: 'SHA-256' },
        },
        publicKey,
        sigBytes,
        new Uint8Array(message)
      );
    } catch (error) {
      console.error('Signature verification failed:', error);
      return false;
    }
  }
  
  export async function verifyDepositAddressSignatures(
    signatures: { [nodeId: string]: string },
    proposal: Proposal
  ): Promise<VerificationResult> {
    try {
      const processedNodes = await processGuardianNodes(GUARDIAN_NODES);
      let verifiedCount = 0;
      const errors: string[] = [];
      const verificationDetails: { [nodeId: string]: boolean } = {};
  
      await Promise.all(
        processedNodes.map(async (node) => {
          try {
            if (!signatures[node.nodeId]) {
              verificationDetails[node.nodeId] = false;
              return;
            }        
            let isVerified = false;
            
            if (proposal.coinType !== 'ethereum') {
              const legacyPayload = legacyProposalToPayload(node.nodeId, proposal);
              isVerified = await verifySignature(node.publicKey, legacyPayload, signatures[node.nodeId]);
              
              if (!isVerified) {
                const newPayload = newProposalToPayload(node.nodeId, proposal);
                isVerified = await verifySignature(node.publicKey, newPayload, signatures[node.nodeId]);
              }
            } else {
              const payload = newProposalToPayload(node.nodeId, proposal);
              isVerified = await verifySignature(node.publicKey, payload, signatures[node.nodeId]);
            }
            
            verificationDetails[node.nodeId] = isVerified;
            if (isVerified) verifiedCount++;
          } catch (error) {
            errors.push(`Verification failed for node ${node.nodeId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            verificationDetails[node.nodeId] = false;
          }
        })
      );
  
      return {
        success: verifiedCount >= GUARDIAN_SIGNATURE_THRESHOLD,
        verifiedCount,
        errors: errors.length > 0 ? errors : undefined,
        verificationDetails
      };
    } catch (error) {
      return {
        success: false,
        verifiedCount: 0,
        errors: [`Global verification error: ${error instanceof Error ? error.message : 'Unknown error'}`],
        verificationDetails: {}
      };
    }
  }
  
  async function main() {
    const depositAddress = "0xCE50D8e79e047534627B3Bc38DE747426Ec63927";
    
    const signatures = {
      'unit-node': 'XG3TKBAuCjPx1xyX3Yws2WKUR0JOaV5iSkZlVfecibrWHP9a3HfAWriHcXNRQH2bKAfT0cbwk5ApliFxmaeXvQ==',
      'hl-node': 'Jt1kwAXxJOxB1moXWUYBIdJ3rc90lM4zOuqBcqlQ00zCKM6RmoxIOr/vG06qBDMt19klSBCPkYiazw6V4xVaaw==',
      'field-node': 'VZ67I8BoGn3prKzEWirLOgjqDGYiCXQiJiBcP5qOPEHeTOMGMIpOYE4JaY6qP6mhlG7TQe2yNE2OMsGC4X6OJA=='
    };

    const result = await verifyDepositAddressSignatures(signatures, {
      destinationAddress: "0x2b2c52B1b63c4BfC7F1A310a1734641D8e34De62",
      destinationChain: 'hyperliquid',
      asset: 'eth',
      address: depositAddress,
      sourceChain: 'ethereum'
    });
    
    console.log('Verification result:', result);
  }
  
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
  