import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { validateQuery } from "../middleware/validate";
import { AppError } from "../middleware/errorHandler";
import { parseGitHubRepo } from "../services/wallet";

const router = Router();

const validateRepoQuerySchema = z.object({
  url: z.string().url(),
});

router.get("/validate-repo", requireAuth, validateQuery(validateRepoQuerySchema), async (request, response, next) => {
  try {
    const repoUrl = String(request.query.url ?? "").trim();
    const repoInfo = parseGitHubRepo(repoUrl);
    if (!repoInfo) {
      throw new AppError(400, 400, "repo_url must point to a GitHub repository");
    }

    const repoAccess = await checkRepositoryAccess(repoInfo.owner, repoInfo.repo);
    if (!repoAccess.accessible) {
      throw new AppError(404, 404, "Repository is not accessible");
    }

    const appInstalled = await verifyGitHubAppInstalled(repoInfo.owner, repoInfo.repo);
    const appSlug = String(process.env.GITHUB_APP_SLUG ?? "").trim();
    const installUrl = appSlug
      ? `https://github.com/apps/${appSlug}/installations/new`
      : "https://github.com/apps";

    if (!appInstalled) {
      return response.status(409).json({
        error: "GitHub App not installed",
        code: 409,
        detail: "GH-C-001: GitHub App not installed",
        install_url: installUrl,
      });
    }

    const hasWorkflows = await checkGitHubActionsWorkflows(repoInfo.owner, repoInfo.repo);

    return response.status(200).json({
      repository_accessible: true,
      app_installed: true,
      has_workflows: hasWorkflows,
      warning: hasWorkflows ? null : "GH-C-003: No CI/CD workflow detected",
      install_url: installUrl,
    });
  } catch (error) {
    return next(error);
  }
});

async function verifyGitHubAppInstalled(owner: string, repo: string) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return process.env.HACKATHON_MODE === "true" || process.env.NODE_ENV !== "production";
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "BountyEscrow-AI",
      },
    });
    return response.ok;
  } catch {
    return process.env.HACKATHON_MODE === "true" || process.env.NODE_ENV !== "production";
  }
}

async function checkGitHubActionsWorkflows(owner: string, repo: string) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return false;
  }

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "BountyEscrow-AI",
    },
  });

  if (!response.ok) {
    return false;
  }

  const payload = (await response.json()) as { total_count?: number };
  return Number(payload.total_count ?? 0) > 0;
}

async function checkRepositoryAccess(owner: string, repo: string) {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "BountyEscrow-AI",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers,
    });
    return { accessible: response.ok };
  } catch {
    return { accessible: false };
  }
}

export default router;
