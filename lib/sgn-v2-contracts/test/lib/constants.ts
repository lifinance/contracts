import { parseUnits } from '@ethersproject/units';

export const PROPOSAL_DEPOSIT = 100;
export const VOTING_PERIOD = 20;
export const UNBONDING_PERIOD = 50;
export const MAX_VALIDATOR_NUM = 7;
export const MIN_VALIDATOR_TOKENS = parseUnits('4');
export const ADVANCE_NOTICE_PERIOD = 10;
export const VALIDATOR_BOND_INTERVAL = 0;
export const MAX_SLASH_FACTOR = 1e5; // 10%

export const MIN_SELF_DELEGATION = parseUnits('2');
export const VALIDATOR_STAKE = parseUnits('1'); // smaller than MIN_VALIDATOR_TOKENS for testing purpose
export const DELEGATOR_STAKE = parseUnits('6');

export const COMMISSION_RATE = 100;
export const SLASH_FACTOR = 50000; // 5%

export const STATUS_UNBONDED = 1;
export const STATUS_UNBONDING = 2;
export const STATUS_BONDED = 3;

export const ENUM_PROPOSAL_DEPOSIT = 0;
export const ENUM_VOTING_PERIOD = 1;
export const ENUM_UNBONDING_PERIOD = 2;
export const ENUM_MAX_VALIDATOR_NUM = 3;
export const ENUM_MIN_VALIDATOR_TOKENS = 4;
export const ENUM_MIN_SELF_DELEGATION = 5;
export const ENUM_ADVANCE_NOTICE_PERIOD = 6;

export const ENUM_VOTE_OPTION_UNVOTED = 0;
export const ENUM_VOTE_OPTION_YES = 1;
export const ENUM_VOTE_OPTION_ABSTAIN = 2;
export const ENUM_VOTE_OPTION_NO = 3;

export const SUB_FEE = parseUnits('100000000', 'wei');

export const TYPE_MSG_XFER = 0;
export const TYPE_MSG_ONLY = 1;

export const MSG_TX_NULL = 0;
export const MSG_TX_SUCCESS = 1;
export const MSG_TX_FAIL = 2;
export const MSG_TX_FALLBACK = 3;

export const XFER_TYPE_LQ_RELAY = 1;
export const XFER_TYPE_LQ_WITHDRAW = 2;
export const XFER_TYPE_PEG_MINT = 3;
export const XFER_TYPE_PEG_WITHDRAW = 4;
export const XFER_TYPE_PEGV2_MINT = 5;
export const XFER_TYPE_PEGV2_WITHDRAW = 6;

export const GovExternalDefault = 0;
export const GovExternalFastPass = 1;
export const GovInternalParamChange = 2;
export const GovInternalVoterUpdate = 3;
export const GovInternalProxyUpdate = 4;
export const GovInternalTokenTransfer = 5;

export const GovParamActivePeriod = 0;
export const GovParamQuorumThreshold = 1;
export const GovParamFastPassThreshold = 2;

export const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export const userPrivKeys = [
  '0x36f2243a51a0f879b1859fff1a663ac04aeebca1bcff4d7dc5a8b38e53211199',
  '0xc0bf10873ddb6d554838f5e4f0c000e85d3307754151add9813ff331b746390d',
  '0x68888cc706520c4d5049d38933e0b502e2863781d75de09c499cf0e4e00ba2de',
  '0x400e64f3b8fe65ecda0bad60627c41fa607172cf0970fbe2551d6d923fd82f78',
  '0xab4c840e48b11840f923a371ba453e4d8884fd23eee1b579f5a3910c9b00a4b6',
  '0x0168ea2aa71023864b1c8eb65997996d726e5068c12b20dea81076ef56380465',
  '0xd3733feb467076219337afed04787c48f5aa23c9c998bee1dc7742d12f7628e9',
  '0xf9d76b9beacb01e431440a2750cb8aec04b782dfa7a7ef62584550e5db7347d6',
  '0xecdd83652d7fddaffa0993f7a7d58d423a76737d7a90e81d06a32aecb8d470db',
  '0xf37790438d0d8108a5bc588f727b84f041e355e825bbb8b36a6c83efa9ad3176',
  '0x212f9e9d305ecd326ef88da498cd869f2e3ff2909f315f88f563594da8663990',
  '0xdf0c45cfa93acf88ed0becd7a41df47e42217c0febc2be4aa7126decbccdc887',
  '0x33209d3c38365492473417af8b03e3e6d3eb4f6269fe33f47edba62882732dbb',
  '0xfe964eb524f182ea08aa2528fc5ec660238908fe77a5dca5f2954388bbe2cfc8',
  '0x03abc71ae40f50de995e97421d28394818352ac91de757411293ec1177563806',
  '0xce86dac0655a8822db84e505c1fdc36410d7e98ac227a9671f309d9dae2c741f',
  '0xbb08d5f77da4a71cefa19f254e347caa0c837d2639d10c8a2bf37aea75c97d15',
  '0x6b2e4b681206a0abca47ad72f194158c18f1a755b96d1fd8797baaec870f6000',
  '0x1f7ede2316ee0423bb38127c6a1fc4d87f5804460757ffb6c3249335e3f2ecb4',
  '0x0f072d61ec1b47e8f09c20e935d942c291d3229932ab1560cc567e32c2f87e94',
  '0xee15c0525cc1f3292e9905d36f78a9ad48551e365174e351ad867c0bb4f54d9e'
];
