/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'fs-extra';
import chalk from 'chalk';
import path from 'path';
import readingTime from 'reading-time';
import {Feed} from 'feed';
import {keyBy, mapValues} from 'lodash';
import {
  PluginOptions,
  BlogPost,
  DateLink,
  BlogContentPaths,
  BlogMarkdownLoaderOptions,
} from './types';
import {
  parseMarkdownFile,
  normalizeUrl,
  aliasedSitePath,
  getEditUrl,
  getFolderContainingFile,
  posixPath,
  replaceMarkdownLinks,
  Globby,
} from '@docusaurus/utils';
import {LoadContext} from '@docusaurus/types';
import {validateBlogPostFrontMatter} from './blogFrontMatter';

export function truncate(fileString: string, truncateMarker: RegExp): string {
  return fileString.split(truncateMarker, 1).shift()!;
}

export function getSourceToPermalink(
  blogPosts: BlogPost[],
): Record<string, string> {
  return mapValues(
    keyBy(blogPosts, (item) => item.metadata.source),
    (v) => v.metadata.permalink,
  );
}

// YYYY-MM-DD-{name}.mdx?
// Prefer named capture, but older Node versions do not support it.
const DATE_FILENAME_PATTERN = /^(\d{4}-\d{1,2}-\d{1,2})-?(.*?).mdx?$/;

function toUrl({date, link}: DateLink) {
  return `${date
    .toISOString()
    .substring(0, '2019-01-01'.length)
    .replace(/-/g, '/')}/${link}`;
}

function formatBlogPostDate(locale: string, date: Date): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  } catch (e) {
    throw new Error(`Can't format blog post date "${date}"`);
  }
}

export async function generateBlogFeed(
  contentPaths: BlogContentPaths,
  context: LoadContext,
  options: PluginOptions,
): Promise<Feed | null> {
  if (!options.feedOptions) {
    throw new Error(
      'Invalid options: "feedOptions" is not expected to be null.',
    );
  }
  const {siteConfig} = context;
  const blogPosts = await generateBlogPosts(contentPaths, context, options);
  if (!blogPosts.length) {
    return null;
  }

  const {feedOptions, routeBasePath} = options;
  const {url: siteUrl, baseUrl, title, favicon} = siteConfig;
  const blogBaseUrl = normalizeUrl([siteUrl, baseUrl, routeBasePath]);

  const updated =
    (blogPosts[0] && blogPosts[0].metadata.date) ||
    new Date('2015-10-25T16:29:00.000-07:00');

  const feed = new Feed({
    id: blogBaseUrl,
    title: feedOptions.title || `${title} Blog`,
    updated,
    language: feedOptions.language,
    link: blogBaseUrl,
    description: feedOptions.description || `${siteConfig.title} Blog`,
    favicon: favicon ? normalizeUrl([siteUrl, baseUrl, favicon]) : undefined,
    copyright: feedOptions.copyright,
  });

  blogPosts.forEach((post) => {
    const {
      id,
      metadata: {title: metadataTitle, permalink, date, description},
    } = post;
    feed.addItem({
      title: metadataTitle,
      id,
      link: normalizeUrl([siteUrl, permalink]),
      date,
      description,
    });
  });

  return feed;
}

export async function generateBlogPosts(
  contentPaths: BlogContentPaths,
  {siteConfig, siteDir, i18n}: LoadContext,
  options: PluginOptions,
): Promise<BlogPost[]> {
  const {
    include,
    exclude,
    routeBasePath,
    truncateMarker,
    showReadingTime,
    editUrl,
  } = options;

  if (!fs.existsSync(contentPaths.contentPath)) {
    return [];
  }

  const {baseUrl = ''} = siteConfig;
  const blogSourceFiles = await Globby(include, {
    cwd: contentPaths.contentPath,
    ignore: exclude,
  });

  const blogPosts: BlogPost[] = [];

  async function processBlogSourceFile(blogSourceFile: string) {
    // Lookup in localized folder in priority
    const blogDirPath = await getFolderContainingFile(
      getContentPathList(contentPaths),
      blogSourceFile,
    );

    const source = path.join(blogDirPath, blogSourceFile);

    const {
      frontMatter: unsafeFrontMatter,
      content,
      contentTitle,
      excerpt,
    } = await parseMarkdownFile(source, {removeContentTitle: true});
    const frontMatter = validateBlogPostFrontMatter(unsafeFrontMatter);

    const aliasedSource = aliasedSitePath(source, siteDir);

    const blogFileName = path.basename(blogSourceFile);

    if (frontMatter.draft && process.env.NODE_ENV === 'production') {
      return;
    }

    if (frontMatter.id) {
      console.warn(
        chalk.yellow(
          `"id" header option is deprecated in ${blogFileName} file. Please use "slug" option instead.`,
        ),
      );
    }

    let date: Date | undefined;
    // Extract date and title from filename.
    const dateFilenameMatch = blogFileName.match(DATE_FILENAME_PATTERN);
    let linkName = blogFileName.replace(/\.mdx?$/, '');

    if (dateFilenameMatch) {
      const [, dateString, name] = dateFilenameMatch;
      // Always treat dates as UTC by adding the `Z`
      date = new Date(`${dateString}Z`);
      linkName = name;
    }

    // Prefer user-defined date.
    if (frontMatter.date) {
      date = new Date(frontMatter.date);
    }

    // Use file create time for blog.
    date = date ?? (await fs.stat(source)).birthtime;
    const formattedDate = formatBlogPostDate(i18n.currentLocale, date);

    const title = frontMatter.title ?? contentTitle ?? linkName;
    const description = frontMatter.description ?? excerpt ?? '';

    const slug =
      frontMatter.slug ||
      (dateFilenameMatch ? toUrl({date, link: linkName}) : linkName);

    const permalink = normalizeUrl([baseUrl, routeBasePath, slug]);

    function getBlogEditUrl() {
      const blogPathRelative = path.relative(blogDirPath, path.resolve(source));

      if (typeof editUrl === 'function') {
        return editUrl({
          blogDirPath: posixPath(path.relative(siteDir, blogDirPath)),
          blogPath: posixPath(blogPathRelative),
          permalink,
          locale: i18n.currentLocale,
        });
      } else if (typeof editUrl === 'string') {
        const isLocalized = blogDirPath === contentPaths.contentPathLocalized;
        const fileContentPath =
          isLocalized && options.editLocalizedFiles
            ? contentPaths.contentPathLocalized
            : contentPaths.contentPath;

        const contentPathEditUrl = normalizeUrl([
          editUrl,
          posixPath(path.relative(siteDir, fileContentPath)),
        ]);

        return getEditUrl(blogPathRelative, contentPathEditUrl);
      } else {
        return undefined;
      }
    }

    blogPosts.push({
      id: frontMatter.slug ?? title,
      metadata: {
        permalink,
        editUrl: getBlogEditUrl(),
        source: aliasedSource,
        title,
        description,
        date,
        formattedDate,
        tags: frontMatter.tags ?? [],
        readingTime: showReadingTime ? readingTime(content).minutes : undefined,
        truncated: truncateMarker?.test(content) || false,
      },
    });
  }

  await Promise.all(
    blogSourceFiles.map(async (blogSourceFile: string) => {
      try {
        return await processBlogSourceFile(blogSourceFile);
      } catch (e) {
        console.error(
          chalk.red(
            `Processing of blog source file failed for path "${blogSourceFile}"`,
          ),
        );
        throw e;
      }
    }),
  );

  blogPosts.sort(
    (a, b) => b.metadata.date.getTime() - a.metadata.date.getTime(),
  );

  return blogPosts;
}

export type LinkifyParams = {
  filePath: string;
  fileString: string;
} & Pick<
  BlogMarkdownLoaderOptions,
  'sourceToPermalink' | 'siteDir' | 'contentPaths' | 'onBrokenMarkdownLink'
>;

export function linkify({
  filePath,
  contentPaths,
  fileString,
  siteDir,
  sourceToPermalink,
  onBrokenMarkdownLink,
}: LinkifyParams): string {
  const {newContent, brokenMarkdownLinks} = replaceMarkdownLinks({
    siteDir,
    fileString,
    filePath,
    contentPaths,
    sourceToPermalink,
  });

  brokenMarkdownLinks.forEach((l) => onBrokenMarkdownLink(l));

  return newContent;
}

// Order matters: we look in priority in localized folder
export function getContentPathList(contentPaths: BlogContentPaths): string[] {
  return [contentPaths.contentPathLocalized, contentPaths.contentPath];
}
