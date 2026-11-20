'use server';

import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';

import { i18n } from '@/i18n/constants';
import { auth } from '@/lib/auth/auth';
import { createUser, validateNewAccount } from '@/lib/auth/create-user';
import { checkSetupToken, clearSetupToken, ensureSetupToken, hasAnyUser } from '@/lib/auth/setup-token';
import { db } from '@/lib/db/client';
import {
  analysisTemplateFields,
  analysisTemplates,
  categories,
  organizationMembers,
  organizations,
  projects,
  speakerPresets,
  taxonomies,
} from '@/lib/db/schema/app';
import { user as userTable } from '@/lib/db/schema/auth';
import { log } from '@/lib/log';

import { type ActionResult, BackendError, NotFoundError, runAction } from './result';

/**
 * First-run setup (item 29): checks the setup token, creates the owner, a default organisation, a
 * first project with starters (#87: a speaker preset, an active "General QA" template and five call
 * reasons) in the setup user's UI language, then signs the owner in.
 */
export async function completeSetup(input: {
  token: string;
  name: string;
  email: string;
  password: string;
}): Promise<ActionResult<{ projectId: string }>> {
  return runAction(async () => {
    if (await hasAnyUser()) throw new NotFoundError();
    if (!checkSetupToken(input?.token)) {
      const t = await getTranslations();
      throw new BackendError(400, t(i18n.setup.invalidToken));
    }
    validateNewAccount(input);
    const t = await getTranslations();
    // The first project allows only the setup user's UI language (#90), so its calls are forced to that
    // language with no detection step; the owner can allow more languages later.

    const created = await createUser({ email: input.email, name: input.name, password: input.password });
    let projectId: string;
    try {
      projectId = await db.transaction(async (tx) => {
        // A second setup racing this one: the first user to commit wins, the other rolls back.
        const others = await tx.select({ id: userTable.id }).from(userTable).limit(2);
        if (others.length > 1) throw new NotFoundError();

        const [org] = await tx
          .insert(organizations)
          .values({ name: t(i18n.setup.orgName), createdBy: created.id })
          .returning({ id: organizations.id });
        await tx.insert(organizationMembers).values({ organizationId: org.id, userId: created.id, role: 'OWNER' });
        const [project] = await tx
          .insert(projects)
          .values({
            name: t(i18n.setup.projectName),
            organizationId: org.id,
            visibility: 'ORG',
            allowedLanguages: [(await getLocale()) === 'pl' ? 'pl' : 'en'],
          })
          .returning({ id: projects.id });

        await tx.insert(speakerPresets).values({
          projectId: project.id,
          userId: created.id,
          name: t(i18n.setup.presetName),
          speakers: [t(i18n.setup.customer), t(i18n.setup.agent)],
          isDefault: true,
        });

        const T = i18n.exampleTemplates.customerSupport;
        const [template] = await tx
          .insert(analysisTemplates)
          .values({ projectId: project.id, userId: created.id, name: t(i18n.setup.templateName), isActive: true })
          .returning({ id: analysisTemplates.id });
        await tx.insert(analysisTemplateFields).values([
          {
            templateId: template.id,
            label: t(T.fields.issueResolved.label),
            prompt: t(T.fields.issueResolved.prompt),
            answerType: 'BOOLEAN',
            displayOrder: 0,
          },
          {
            templateId: template.id,
            label: t(T.fields.customerSentiment.label),
            prompt: t(T.fields.customerSentiment.prompt),
            answerType: 'CHOICE',
            options: T.options.map((key) => t(key)),
            displayOrder: 1,
          },
          {
            templateId: template.id,
            label: t(T.fields.summary.label),
            prompt: t(T.fields.summary.prompt),
            answerType: 'TEXT',
            displayOrder: 2,
          },
        ]);

        const [taxonomy] = await tx
          .insert(taxonomies)
          .values({ projectId: project.id, userId: created.id })
          .returning({ id: taxonomies.id });
        const C = i18n.setup.categories;
        const starters = [
          [i18n.suggestions.categories.complaints.name, i18n.suggestions.categories.complaints.description],
          [C.question.name, C.question.description],
          [C.order.name, C.order.description],
          [C.cancellation.name, C.cancellation.description],
          [C.other.name, C.other.description],
        ];
        await tx.insert(categories).values(
          starters.map(([name, description], i) => ({
            taxonomyId: taxonomy.id,
            name: t(name),
            description: t(description),
            displayOrder: i,
          }))
        );
        return project.id;
      });
    } catch (e) {
      // Leave no orphan user behind, so setup can be tried again.
      const ctx = await auth.$context;
      await ctx.internalAdapter.deleteUser(created.id).catch(() => {});
      throw e;
    }

    clearSetupToken();
    log('info', 'setup completed', { user_id: created.id, project_id: projectId });
    await auth.api.signInEmail({ body: { email: input.email, password: input.password }, headers: await headers() });
    return { projectId };
  });
}

/** For the setup page: whether to show the form, and makes sure a token exists in the log. */
export async function setupStatus(): Promise<{ open: boolean }> {
  if (await hasAnyUser()) return { open: false };
  await ensureSetupToken();
  return { open: true };
}
