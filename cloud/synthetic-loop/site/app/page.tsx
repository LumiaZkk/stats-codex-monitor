import { requireChatGPTUser } from './chatgpt-auth';
import BridgeClient from './bridge-client';
export const dynamic = 'force-dynamic';
export default async function Home() {
  await requireChatGPTUser('/');
  return <BridgeClient/>;
}
