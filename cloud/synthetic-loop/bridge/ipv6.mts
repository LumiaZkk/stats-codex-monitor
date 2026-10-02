import { isIP } from 'node:net';

// Conservative snapshot of ordinary RIR-allocated IPv6 unicast space, checked
// 2026-09-30 against IANA's Global Unicast table (updated 2025-10-10) and
// Special-Purpose table (updated 2025-10-09). Unknown future allocations fail
// closed until this reviewed table is updated. This does not assert reachability.
// https://www.iana.org/assignments/ipv6-unicast-address-assignments
// https://www.iana.org/assignments/iana-ipv6-special-registry
function ipv6Number(value:string):bigint|null {
  if(typeof value!=='string' || value.includes('%') || isIP(value)!==6)return null;
  let address=value.toLowerCase();
  if(address.includes('.')){
    const at=address.lastIndexOf(':'),tail=address.slice(at+1);
    if(isIP(tail)!==4)return null;
    const octets=tail.split('.').map(Number);
    address=address.slice(0,at+1)+((octets[0]<<8)|octets[1]).toString(16)+':'+((octets[2]<<8)|octets[3]).toString(16);
  }
  const halves=address.split('::'),left=halves[0]?halves[0].split(':'):[],right=halves.length===2 && halves[1]?halves[1].split(':'):[];
  const words=halves.length===2 ? [...left,...Array(8-left.length-right.length).fill('0'),...right] : left;
  if(words.length!==8)return null;
  return words.reduce((value,word)=>(value<<16n)|BigInt(parseInt(word,16)),0n);
}
function prefix(value:string,bits:number):readonly[bigint,bigint]{const address=ipv6Number(value);if(address===null)throw new Error('invalid_static_ipv6_prefix');const shift=BigInt(128-bits);return [address>>shift,shift];}
const allocated=[
  prefix('2001:200::',23),prefix('2001:400::',23),prefix('2001:600::',23),prefix('2001:800::',22),prefix('2001:c00::',23),prefix('2001:e00::',23),
  prefix('2001:1200::',23),prefix('2001:1400::',22),prefix('2001:1800::',23),prefix('2001:1a00::',23),prefix('2001:1c00::',22),prefix('2001:2000::',19),
  prefix('2001:4000::',23),prefix('2001:4200::',23),prefix('2001:4400::',23),prefix('2001:4600::',23),prefix('2001:4800::',23),prefix('2001:4a00::',23),
  prefix('2001:4c00::',23),prefix('2001:5000::',20),prefix('2001:8000::',19),prefix('2001:a000::',20),prefix('2001:b000::',20),prefix('2003::',18),
  prefix('2400::',12),prefix('2410::',12),prefix('2600::',12),prefix('2610::',23),prefix('2620::',23),prefix('2630::',12),
  prefix('2800::',12),prefix('2a00::',12),prefix('2a10::',12),prefix('2c00::',12),
];
// Deny all listed special-purpose blocks within candidate unicast space, even
// special anycast services marked globally reachable. Other special, mapped,
// registered NAT64, local, multicast, deprecated and reserved space is outside the allowlist.
const special=[prefix('2001::',23),prefix('2001:db8::',32),prefix('2002::',16),prefix('2620:4f:8000::',48),prefix('3fff::',20)];
export function publicIPv6(address:string):boolean {
  const value=ipv6Number(address);if(value===null)return false;
  // RFC 5214 section 6.1: ISATAP embeds IPv4 in these interface identifiers
  // even under otherwise ordinary globally allocated prefixes.
  const iidPrefix=(value>>32n)&0xffffffffn;
  if(iidPrefix===0x00005efen || iidPrefix===0x02005efen)return false;
  const matches=([network,shift]:readonly[bigint,bigint])=>(value>>shift)===network;
  return allocated.some(matches) && !special.some(matches);
}
