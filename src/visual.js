// Very small, bounded downsample; native libvips/SIMD via sharp, not JS JPEG loops.
// This fallback runs only when an exact Pragmatic runtime control cannot be located.
export async function imageSignature(jpeg){
  const {default:sharp}=await import('sharp');
  const raw=await sharp(jpeg,{limitInputPixels:12_000_000})
    .resize(32,18,{fit:'fill'}).greyscale().raw().toBuffer();
  return raw.toString('base64');
}
export function signatureDiff(a,b){
  if(!a||!b)return 1;
  const x=Buffer.from(a,'base64'),y=Buffer.from(b,'base64');
  if(x.length!==y.length||!x.length)return 1;
  let sum=0;
  for(let i=0;i<x.length;i++)sum+=Math.abs(x[i]-y[i]);
  return sum/(x.length*255);
}
