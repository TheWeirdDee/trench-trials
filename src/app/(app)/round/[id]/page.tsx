import { RoundClient } from './RoundClient';

export default async function RoundPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RoundClient roundId={id} />;
}
