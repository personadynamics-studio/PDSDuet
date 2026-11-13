import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { MicOrb } from "@/components/duet/mic-orb";
import { ProviderLogo } from "@/components/auth/provider-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { authClient } from "@/lib/auth/client";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { appConfig } from "@/lib/generated/application-config";
import { searchTextEntry } from "@/lib/search-text";
import type { AuthProviderId } from "../lib/auth/queries";

const PROVIDER_NAMES = { google: "Google", microsoft: "Microsoft", okta: "Okta" };

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const ENTRANCE_SECONDS = 0.4;
const ENTRANCE_STAGGER_SECONDS = 0.08;
const ENTRANCE_OFFSET = "translateY(12px)";

export const Route = createFileRoute("/sign")({
  /*
   * `?flow_id=` is the handle a brokered authorization arrived with, sent here when its session had
   * lapsed. It is carried back as an encoded query value on this app's verifier.
   *
   * READ AS TEXT WHATEVER THE ROUTER PARSED IT INTO, which is what `searchText` is for: a handle
   * made of digits arrives here as a number and a JSON-shaped one as an object, so a `typeof`
   * guard would drop the correlation for whichever handles the vendor's generator happens to emit
   * — working in testing and losing the return leg's binding in production.
   *
   * The key is omitted rather than set to undefined, for the reason the connected-accounts screen
   * gives for `?connected=`: present-but-undefined makes `search` a required prop on every Link to
   * this route, which is a lot of ripple for a parameter only the verifier sets.
   */
  validateSearch: (search: Record<string, unknown>): { flow_id?: string } =>
    searchTextEntry("flow_id", search.flow_id),
  component: SignScreen,
});

function SignScreen() {
  const { flow_id: flowId } = Route.useSearch();
  const [error, setError] = useState<string | null>(null);
  const options = useQuery(deploymentCapabilitiesQueryOptions());
  const providers = options.data?.authProviders ?? [];
  const callbackURL = flowId
    ? `/api/plugins/arcade/verify?flow_id=${encodeURIComponent(flowId)}`
    : "/";
  const [email, setEmail] = useState("");

  /**
   * Sign in through whichever identity provider covers this address.
   *
   * No password is asked for and none is checked here: only the part after the @ is used, to decide
   * which registered provider to hand somebody to.
   */
  async function handleDomainSignIn(submission: React.FormEvent) {
    submission.preventDefault();
    setError(null);

    try {
      const result = await authClient.signIn.sso({ email, callbackURL });
      if (result.error) setError(result.error.message ?? "無法開啟公司登入。");
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "這個電郵地址尚未設定公司登入。",
      );
    }
  }

  async function handleSignIn(provider: AuthProviderId) {
    setError(null);

    try {
      const result = await authClient.signIn.social({ provider, callbackURL });
      if (result.error) setError(result.error.message ?? "無法開啟登入。");
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : `無法開啟 ${PROVIDER_NAMES[provider]} 登入，請重試。`,
      );
    }
  }

  const providerButtons = (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => (
        /*
         * Every provider gets the same button, and it is the light-themed outline one
         * rather than the app's filled primary. Google's guidelines require their button be
         * at least as prominent as any other sign-in option and specify its fill and
         * stroke, so making one provider the loud one would break that for the others. The
         * same size and weight throughout is also the honest presentation: a deployment
         * that configured three has three, and none of them is the recommended one.
         */
        <Button
          className="h-10 w-full justify-start gap-3 px-3 tracking-tight"
          key={provider}
          onClick={() => handleSignIn(provider)}
          size="lg"
          variant="outline"
        >
          <ProviderLogo provider={provider} />
          {/* Centred against the button, not against the space left of the mark. */}
          <span className="flex-1 text-center">
            使用 {PROVIDER_NAMES[provider]} 繼續
          </span>
          {/* Balances the mark so the label sits in the middle of the button. */}
          <span aria-hidden="true" className="size-[18px]" />
        </Button>
      ))}
    </div>
  );

  const prefersReducedMotion = useReducedMotion();
  const hidden = {
    opacity: 0,
    ...(prefersReducedMotion ? {} : { transform: ENTRANCE_OFFSET }),
  };
  const shown = {
    opacity: 1,
    ...(prefersReducedMotion ? {} : { transform: "translateY(0px)" }),
  };

  return (
    <div className="flex flex-col h-dvh w-full items-center justify-center -mt-12">
      <motion.div
        animate="shown"
        className="flex-1 flex w-full max-w-82 flex-col items-center justify-center p-4"
        initial="hidden"
        variants={{
          hidden: {},
          shown: { transition: { staggerChildren: ENTRANCE_STAGGER_SECONDS } },
        }}
      >
        <motion.div
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
          className="flex items-center justify-center"
        >
          <MicOrb size={56} />
        </motion.div>
        <motion.h1
          className="text-2xl font-medium tracking-tight text-center mt-8"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          登入 {appConfig.brand.productName}
        </motion.h1>
        <motion.div
          className="mt-8 w-full"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          {options.isPending ? <p role="status">正在讀取登入方式…</p> : null}
          {options.error ? <p role="alert">{options.error.message}</p> : null}
          {providerButtons}
          {options.data && providers.length === 0 && !options.data.ssoConfigured ? (
            <p className="text-center text-sm text-muted-foreground">尚未設定登入。</p>
          ) : null}
          {/*
           * The way in for a company that runs its own identity provider.
           *
           * Below the buttons, because a deployment with both has more people arriving through the
           * buttons: the registered providers are for the companies whose IdP was added by hand.
           */}
          {options.data?.ssoConfigured ? (
            <form className="mt-3" onSubmit={handleDomainSignIn}>
              {providers.length > 0 ? (
                <div className="mb-3 flex items-center gap-3">
                  <Separator className="flex-1" />
                  <span className="text-muted-foreground text-xs">或</span>
                  <Separator className="flex-1" />
                </div>
              ) : null}
              <Input
                autoComplete="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
                required
                type="email"
                value={email}
              />
              <Button
                className="mt-2 h-10 w-full tracking-tight"
                size="lg"
                type="submit"
                variant="outline"
              >
                使用公司帳戶繼續
              </Button>
            </form>
          ) : null}
          {error ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </motion.div>
      </motion.div>
    </div>
  );
}
