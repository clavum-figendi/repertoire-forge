export const DEFAULT_CLOUD_URL='';
export function cloudBase(value=DEFAULT_CLOUD_URL){if(!value)throw new Error('Set a deployed cloud backend URL in Settings first.');const u=new URL(value);if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||!(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname))))throw new Error('Use an HTTPS backend origin.');return u.origin;}
export async function cloudRequest(base,path,{method='GET',body,token,signal}={}){
 if(!/^\/(?:health|jobs(?:\/[A-Za-z0-9_-]+(?:\/(?:step|result))?)?)$/.test(path))throw new Error('Invalid backend route');
 const response=await fetch(cloudBase(base)+path,{method,signal,credentials:'omit',redirect:'error',headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json();if(!response.ok)throw new Error(data.error||`Cloud backend HTTP ${response.status}`);return data;
}
