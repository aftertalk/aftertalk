'use client';

import { useParams } from 'next/navigation';

import { InAppNotFound } from '@/components/shared/in-app-not-found';

export default function ProjectNotFound() {
  const { projectId } = useParams<{ projectId: string }>();
  return <InAppNotFound projectId={projectId} />;
}
