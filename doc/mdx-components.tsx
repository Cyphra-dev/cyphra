import { useMDXComponents as getThemeComponents } from "nextra-theme-docs";
import type { MDXComponents } from "nextra/mdx-components";
import { JsonLd } from "./components/seo/json-ld";
import { breadcrumbList } from "./components/seo/structured-data";
import { crumbsFor } from "./lib/breadcrumbs";

type MDXWrapper = NonNullable<MDXComponents["wrapper"]>;

const themeComponents = getThemeComponents();
const ThemeWrapper = themeComponents.wrapper as MDXWrapper;

/**
 * The theme's page wrapper, plus BreadcrumbList JSON-LD for every page that has a trail (all but
 * the landing page). Also used directly by the blog and glossary pages, which render Markdown from
 * content/ outside an MDX page file.
 */
export const PageWrapper: MDXWrapper = ({ children, ...props }) => {
  const crumbs = crumbsFor(props.metadata.filePath, props.metadata.title);
  return (
    <ThemeWrapper {...props}>
      {children}
      {crumbs ? <JsonLd data={breadcrumbList(crumbs)} /> : null}
    </ThemeWrapper>
  );
};

export function useMDXComponents(components?: MDXComponents): MDXComponents {
  return { ...themeComponents, wrapper: PageWrapper, ...components };
}
