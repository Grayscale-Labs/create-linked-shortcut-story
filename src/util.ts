import * as core from "@actions/core";
import * as github from "@actions/github";
import { PullRequestEvent } from "@octokit/webhooks-types";
import { HttpClient } from "@actions/http-client";
import Mustache from "mustache";
import {
  ShortcutGroup,
  ShortcutMember,
  ShortcutProject,
  ShortcutStory,
  ShortcutCreateStoryBody,
  ShortcutUpdateStoryBody,
  ShortcutWorkflowState,
  ShortcutTeam,
  ShortcutIterationSlim,
} from "./types";

export const SHORTCUT_STORY_URL_REGEXP =
  /https:\/\/app.shortcut.com\/\w+\/story\/(\d+)(\/[A-Za-z0-9-]*)?/;
export const SHORTCUT_BRANCH_NAME_REGEXP = /^(?:.+[-/])?sc(\d+)(?:[-/].+)?$/;

interface Stringable {
  toString(): string;
}

interface IterationInfo {
  groupId: string;
  excludeName?: string;
}

/**
 * Convert a Map to a sorted string representation. Useful for debugging.
 *
 * @param {Map} map - The input Map to convert to a string.
 * @returns {string} Sorted string representation.
 */
function stringFromMap(map: Map<Stringable, Stringable>): string {
  return JSON.stringify(Object.fromEntries(Array.from(map.entries()).sort()));
}

export function shouldProcessPullRequestForUser(user: string): boolean {
  const ignoredUsers = getUserListAsSet(core.getInput("ignored-users"));
  const onlyUsers = getUserListAsSet(core.getInput("only-users"));

  if (ignoredUsers.size === 0 && onlyUsers.size === 0) {
    core.debug(
      "No users defined in only-users or ignored-users. Proceeding with Shortcut workflow..."
    );
    return true;
  }

  if (onlyUsers.size > 0 && ignoredUsers.size > 0) {
    if (onlyUsers.has(user) && ignoredUsers.has(user)) {
      const errorMessage = `PR author ${user} is defined in both ignored-users and only-users lists. Cancelling Shortcut workflow...`;
      core.setFailed(errorMessage);
      throw new Error(errorMessage);
    } else {
      core.debug(
        `Users are defined in both lists. This may create unexpected results.`
      );
    }
  }

  if (onlyUsers.size > 0) {
    if (onlyUsers.has(user)) {
      core.debug(
        `PR author ${user} is defined in only-users list. Proceeding with Shortcut workflow...`
      );
      return true;
    } else {
      core.debug(
        `You have defined a only-users list, but PR author ${user} isn't in this list. Ignoring user...`
      );
      return false;
    }
  }

  if (ignoredUsers.size > 0) {
    if (ignoredUsers.has(user)) {
      core.debug(
        `PR author ${user} is defined in ignored-users list. Ignoring user...`
      );
      return false;
    } else {
      core.debug(
        `PR author ${user} is NOT defined in ignored-users list. Proceeding with Shortcut workflow...`
      );
      return true;
    }
  }

  return true;
}

export function getUserListAsSet(userList: string): Set<string> {
  const s = new Set<string>();
  if (userList) {
    for (const username of userList.split(",")) {
      s.add(username.trim());
    }
  }
  return s;
}

export async function getShortcutUserId(
  githubUsername: string,
  http: HttpClient
): Promise<string | undefined> {
  const USER_MAP_STRING = core.getInput("user-map");
  if (USER_MAP_STRING) {
    try {
      const USER_MAP = JSON.parse(USER_MAP_STRING) as Record<string, string>;
      if (githubUsername in USER_MAP) {
        return USER_MAP[githubUsername];
      }
    } catch (err) {
      core.warning("`user-map` is not valid JSON");
    }
  }

  const SHORTCUT_TOKEN = core.getInput("shortcut-token", {
    required: true,
  });

  let emailToShortcutId;

  try {
    const membersResponse = await http.getJson<ShortcutMember[]>(
      `https://api.app.shortcut.com/api/v3/members?token=${SHORTCUT_TOKEN}`
    );
    const members = membersResponse.result;
    if (!members) {
      core.setFailed(
        `HTTP ${membersResponse.statusCode} https://api.app.shortcut.com/api/v3/members`
      );
      return;
    }
    emailToShortcutId = members.reduce((e2id, member) => {
      const email = member.profile.email_address;
      const shortcutId = member.id;
      if (email) {
        e2id.set(email, shortcutId);
      }
      return e2id;
    }, new Map<string, string>());
    core.debug(`email to Shortcut ID: ${stringFromMap(emailToShortcutId)}`);
  } catch (err) {
    core.setFailed(
      `HTTP ${err.statusCode} https://api.app.shortcut.com/api/v3/members\n${err.message}`
    );
    return;
  }

  const GITHUB_TOKEN = core.getInput("github-token", {
    required: true,
  });

  const octokit = github.getOctokit(GITHUB_TOKEN);
  const userResponse = await octokit.rest.users.getByUsername({
    username: githubUsername,
  });
  const user = userResponse.data;
  if (user.email) {
    return emailToShortcutId.get(user.email);
  } else {
    core.warning(
      `could not get email address for GitHub user @${githubUsername}`
    );
  }
}

export async function getShortcutStoryById(
  id: number | string,
  http: HttpClient
): Promise<ShortcutStory | null> {
  const SHORTCUT_TOKEN = core.getInput("shortcut-token", {
    required: true,
  });
  try {
    const storyResponse = await http.getJson<ShortcutStory>(
      `https://api.app.shortcut.com/api/v3/stories/${id}?token=${SHORTCUT_TOKEN}`
    );
    const story = storyResponse.result;
    if (!story) {
      core.setFailed(
        `HTTP ${storyResponse.statusCode} https://api.app.shortcut.com/api/v3/stories/${id}`
      );
    }
    return story;
  } catch (err) {
    core.setFailed(
      `HTTP ${err.statusCode} https://api.app.shortcut.com/api/v3/stories/${id}\n${err.message}`
    );
    return null;
  }
}

export async function getShortcutProject(
  id: number | string,
  http: HttpClient
): Promise<ShortcutProject | null> {
  const SHORTCUT_TOKEN = core.getInput("shortcut-token", {
    required: true,
  });
  try {
    const projectResponse = await http.getJson<ShortcutProject>(
      `https://api.app.shortcut.com/api/v3/projects/${id}?token=${SHORTCUT_TOKEN}`
    );
    return projectResponse.result;
  } catch (err) {
    core.setFailed(
      `HTTP ${err.statusCode} https://api.app.shortcut.com/api/v3/projects/${id}\n${err.message}`
    );
    return null;
  }
}

export async function getShortcutProjectByName(
  projectName: string,
  http: HttpClient
): Promise<ShortcutProject | undefined> {
  const SHORTCUT_TOKEN = core.getInput("shortcut-token", {
    required: true,
  });
  try {
    const projectsResponse = await http.getJson<ShortcutProject[]>(
      `https://api.app.shortcut.com/api/v3/projects?token=${SHORTCUT_TOKEN}`
    );
    const projects = projectsResponse.result;
    if (!projects) {
      core.setFailed(
        `HTTP ${projectsResponse.statusCode} https://api.app.shortcut.com/api/v3/projects`
      );
      return;
    }
    return projects.find((project) => project.name === projectName);
  } catch (err) {
    core.setFailed(
      `HTTP ${err.statusCode} https://api.app.shortcut.com/api/v3/projects\n${err.message}`
    );
    return;
  }
}

export async function getShortcutGroupByName(
  groupName: string,
  http: HttpClient
): Promise<ShortcutGroup | undefined> {
  const SHORTCUT_TOKEN = core.getInput("shortcut-token", {
    required: true,
  });
  try {
    const groupsResponse = await http.getJson<ShortcutGroup[]>(
      `https://api.app.shortcut.com/api/v3/groups?token=${SHORTCUT_TOKEN}`
    );
    const groups = groupsResponse.result;
    if (!groups) {
      core.setFailed(
        `HTTP ${groupsResponse.statusCode} https://api.app.shortcut.com/api/v3/groups`
      );
      return;
    }
    return groups.find((group) => group.name === groupName);
  } catch (err) {
    core.setFailed(
      `HTTP ${err.statusCode} https://api.app.shortcut.com/api/v3/groups\n${err.message}`
    );
    return;
  }
}

export async function getShortcutWorkflowState(
  stateName: string,
  http: HttpClient,
  project: ShortcutProject
): Promise<ShortcutWorkflowState | null> {
  const SHORTCUT_TOKEN = core.getInput("shortcut-token", {
    required: true,
  });

  const teamId = project.team_id;

  try {
    const teamResponse = await http.getJson<ShortcutTeam>(
      `https://api.app.shortcut.com/api/v3/teams/${teamId}?token=${SHORTCUT_TOKEN}`
    );

    const team = teamResponse.result;
    if (!team) {
      core.setFailed(
        `HTTP ${teamResponse.statusCode} https://api.app.shortcut.com/api/v3/teams/${teamId}`
      );
      return null;
    }

    return (
      team.workflow.states.find((state) => state.name === stateName) || null
    );
  } catch (err) {
    core.setFailed(
      `HTTP ${err.statusCode} https://api.app.shortcut.com/api/v3/teams/${teamId}\n${err.message}`
    );
    return null;
  }
}

export async function createShortcutStory(
  payload: PullRequestEvent,
  http: HttpClient
): Promise<ShortcutStory | null> {
  const SHORTCUT_TOKEN = core.getInput("shortcut-token", { required: true });
  const PROJECT_NAME = core.getInput("project-name", { required: true });
  const STATE_NAME = core.getInput("opened-state-name");
  const TITLE_TEMPLATE = core.getInput("story-title-template");
  const TEAM_NAME = core.getInput("team-name");
  const title = Mustache.render(TITLE_TEMPLATE, { payload });

  const DESCRIPTION_TEMPLATE = core.getInput("story-description-template");
  const description = Mustache.render(DESCRIPTION_TEMPLATE, { payload });

  const githubUsername = payload.pull_request.user.login;
  const shortcutUserId = await getShortcutUserId(githubUsername, http);
  const shortcutProject = await getShortcutProjectByName(PROJECT_NAME, http);
  if (!shortcutProject) {
    core.setFailed(`Could not find Shortcut project: ${PROJECT_NAME}`);
    return null;
  }

  const body: ShortcutCreateStoryBody = {
    name: title,
    description,
    project_id: shortcutProject.id,
    external_links: [payload.pull_request.html_url],
  };
  if (shortcutUserId) {
    body.owner_ids = [shortcutUserId];
  }
  if (STATE_NAME) {
    const workflowState = await getShortcutWorkflowState(
      STATE_NAME,
      http,
      shortcutProject
    );
    if (workflowState) {
      body.workflow_state_id = workflowState.id;
    }
  }
  if (TEAM_NAME) {
    const shortcutGroup = await getShortcutGroupByName(TEAM_NAME, http);
    if (shortcutGroup) {
      body.group_id = shortcutGroup.id;
    }
  }

  try {
    const storyResponse = await http.postJson<ShortcutStory>(
      `https://api.app.shortcut.com/api/v3/stories?token=${SHORTCUT_TOKEN}`,
      body
    );
    const story = storyResponse.result;
    if (!story) {
      core.setFailed(
        `HTTP ${
          storyResponse.statusCode
        } https://api.app.shortcut.com/api/v3/stories\n${JSON.stringify(body)}`
      );
      return null;
    }
    return storyResponse.result;
  } catch (err) {
    core.setFailed(
      `HTTP ${
        err.statusCode
      } https://api.app.shortcut.com/api/v3/stories\n${JSON.stringify(body)}\n${
        err.message
      }`
    );
    return null;
  }
}

export function getShortcutStoryIdFromBranchName(
  branchName: string
): string | null {
  const match = branchName.match(SHORTCUT_BRANCH_NAME_REGEXP);
  if (match) {
    return match[1];
  }
  return null;
}

export async function getShortcutURLFromPullRequest(
  payload: PullRequestEvent
): Promise<string | null> {
  const GITHUB_TOKEN = core.getInput("github-token", {
    required: true,
  });

  // is there a shortcut link in the description?
  const results = payload.pull_request.body?.match(SHORTCUT_STORY_URL_REGEXP);
  if (results) {
    return results[0];
  }

  // what about in the first page of comments?
  const octokit = github.getOctokit(GITHUB_TOKEN);
  const params = {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    issue_number: payload.pull_request.number,
  };
  const commentsResponse = await octokit.rest.issues.listComments(params);
  if (commentsResponse.status === 200) {
    const commentWithURL = commentsResponse.data.find(
      (comment) => comment.body && SHORTCUT_STORY_URL_REGEXP.test(comment.body)
    );
    if (commentWithURL) {
      const match = commentWithURL.body?.match(SHORTCUT_STORY_URL_REGEXP);
      if (match) {
        return match[0];
      }
    }
  } else {
    core.warning(
      `HTTP ${
        commentsResponse.status
      } octokit.issues.listComments(${JSON.stringify(params)})`
    );
  }

  return null;
}

export async function getShortcutStoryIdFromPullRequest(
  payload: PullRequestEvent
): Promise<string | null> {
  const branchName = payload.pull_request.head.ref;
  const storyId = getShortcutStoryIdFromBranchName(branchName);
  if (storyId) {
    return storyId;
  }

  const shortcutURL = await getShortcutURLFromPullRequest(payload);
  if (!shortcutURL) {
    return null;
  }

  const match = shortcutURL.match(SHORTCUT_STORY_URL_REGEXP);
  if (match) {
    return match[1];
  }
  return null;
}

export async function addCommentToPullRequest(
  payload: PullRequestEvent,
  comment: string
): Promise<boolean> {
  const GITHUB_TOKEN = core.getInput("github-token", {
    required: true,
  });

  const octokit = github.getOctokit(GITHUB_TOKEN);
  const params = {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    issue_number: payload.pull_request.number,
    body: comment,
  };
  const commentResponse = await octokit.rest.issues.createComment(params);
  if (commentResponse.status !== 201) {
    core.setFailed(
      `HTTP ${
        commentResponse.status
      } octokit.issues.createComment(${JSON.stringify(params)})`
    );
    return false;
  }
  return true;
}

export async function updateShortcutStoryById(
  id: number | string,
  http: HttpClient,
  body: ShortcutUpdateStoryBody
): Promise<ShortcutStory | null> {
  const SHORTCUT_TOKEN = core.getInput("shortcut-token", {
    required: true,
  });
  try {
    const storyResponse = await http.putJson<ShortcutStory>(
      `https://api.app.shortcut.com/api/v3/stories/${id}?token=${SHORTCUT_TOKEN}`,
      body
    );
    const story = storyResponse.result;
    if (!story) {
      core.setFailed(
        `HTTP ${storyResponse.statusCode} https://api.app.shortcut.com/api/v3/stories/${id}`
      );
    }
    return story;
  } catch (err) {
    core.setFailed(
      `HTTP ${err.statusCode} https://api.app.shortcut.com/api/v3/stories/${id}\n${err.message}`
    );
    return null;
  }
}

export async function getLatestMatchingShortcutIteration(
  iterationInfo: IterationInfo,
  http: HttpClient
): Promise<ShortcutIterationSlim | undefined> {
  const SHORTCUT_TOKEN = core.getInput("shortcut-token", {
    required: true,
  });
  try {
    const iterationsResponse = await http.getJson<ShortcutIterationSlim[]>(
      `https://api.app.shortcut.com/api/v3/iterations?token=${SHORTCUT_TOKEN}`
    );
    const iterations = iterationsResponse.result;
    if (!iterations) {
      core.setFailed(
        `HTTP ${iterationsResponse.statusCode} https://api.app.shortcut.com/api/v3/iterations`
      );
      return;
    }
    const iterationsForGroup = iterations.filter((iteration) => {
      if (iteration.status !== "started") {
        return false;
      }
      if (!iteration.group_ids.includes(iterationInfo.groupId)) {
        return false;
      }
      if (
        iterationInfo.excludeName &&
        iteration.name.includes(iterationInfo.excludeName)
      ) {
        return false;
      }
      return true;
    });
    if (iterationsForGroup.length === 0) {
      return;
    }
    // sort most-recently updated first
    const sortedIterations = iterationsForGroup.sort(
      (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)
    );
    return sortedIterations[0];
  } catch (err) {
    core.setFailed(
      `HTTP ${err.statusCode} https://api.app.shortcut.com/api/v3/iterations\n${err.message}`
    );
    return;
  }
}

export function getShortcutIterationInfo(
  githubLabel: string
): IterationInfo | undefined {
  const LABEL_MAP_STRING = core.getInput("label-iteration-group-map");
  if (!LABEL_MAP_STRING) {
    core.warning("`label-iteration-group-map` is empty or unset");
    return;
  }
  try {
    const LABEL_MAP = JSON.parse(LABEL_MAP_STRING) as Record<
      string,
      IterationInfo
    >;

    const info = LABEL_MAP[githubLabel];
    if (info) {
      if (!info.groupId) {
        core.warning(
          `missing "groupId" key from "${githubLabel}" label in "label-iteration-group-map"; skipping`
        );
        return;
      }
      return info;
    }
  } catch (err) {
    core.warning("`label-iteration-group-map` is not valid JSON");
    return;
  }
}

/* Use with caution! Only to resolve potential races in event handling */
export function delay(ms: number): Promise<typeof setTimeout> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
