import { describe, expect, it } from 'vitest';
import {
  addressOf,
  bytesToHex,
  checksumAddress,
  encodeType,
  hashStruct,
  keccak256,
  recoverAddress,
  selector,
  signDigest,
  typedDataDigest,
  type Types,
} from './evm.ts';

// The EIP-712 reference example: ethereum/EIPs assets/eip-712/Example.js (v = 28).
const MAIL_TYPES: Types = {
  Person: [
    { name: 'name', type: 'string' },
    { name: 'wallet', type: 'address' },
  ],
  Mail: [
    { name: 'from', type: 'Person' },
    { name: 'to', type: 'Person' },
    { name: 'contents', type: 'string' },
  ],
};
const MAIL_DOMAIN = {
  name: 'Ether Mail',
  version: '1',
  chainId: 1n,
  verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
};
const MAIL = {
  from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
  to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
  contents: 'Hello, Bob!',
};

describe('EVM primitives', () => {
  it('hashes keccak-256, not FIPS SHA3', () => {
    expect(bytesToHex(keccak256(''))).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  });

  it('matches the EIP-712 reference vectors', () => {
    expect(encodeType(MAIL_TYPES, 'Mail')).toBe('Mail(Person from,Person to,string contents)Person(string name,address wallet)');
    expect(bytesToHex(hashStruct(MAIL_TYPES, 'Mail', MAIL))).toBe('0xc52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e');
    const digest = typedDataDigest(MAIL_DOMAIN, MAIL_TYPES, 'Mail', MAIL);
    expect(bytesToHex(digest)).toBe('0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2');

    const cow = keccak256('cow');
    expect(addressOf(cow)).toBe('0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826');
    const signature = signDigest(digest, cow);
    expect(signature).toBe(
      '0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b915621c',
    );
    expect(recoverAddress(digest, signature)).toBe('0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826');
  });

  it('writes EIP-55 checksums and function selectors', () => {
    expect(checksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
    expect(bytesToHex(selector('balanceOf(address)'))).toBe('0x70a08231');
    expect(bytesToHex(selector('transfer(address,uint256)'))).toBe('0xa9059cbb');
  });
});
