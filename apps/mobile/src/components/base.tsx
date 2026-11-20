import React from 'react';
import { Image, Platform, View, Text as RNText, TextInput as RNTextInput } from 'react-native';
import { SvgXml } from 'react-native-svg';
import type { Engine } from '@aidb/core';
import brandMark from '../../assets/brand-mark.png';
import { colors, getThemeMode } from '../theme';
import { ENGINE_LOGO_PNG, ENGINE_LOGO_SVG, LETTER_BADGES, MONO_ENGINE_LOGOS, BRIGHT_ENGINE_LOGOS } from '../engineLogos';
import { translate } from '../i18n';
import { styles } from '../styles';

export function Text(props: React.ComponentProps<typeof RNText>) {
  const children = React.Children.map(props.children, (child) => (typeof child === 'string' ? translate(child) : child));
  return <RNText {...props}>{children}</RNText>;
}

/** 与桌面端 .brand-mark 同一份品牌资源，不随主题变化。 */
export function BrandMark({ size }: { size: number }) {
  return <Image source={brandMark} style={{ width: size, height: size }} resizeMode="contain" accessibilityIgnoresInvertColors />;
}

/** 引擎官方 logo：与桌面 EngineIcon 同一套资源；暗色下反转接近黑色的 logo。 */
export function EngineLogo({ engine, size = 16 }: { engine?: string; size?: number }) {
  const key = (engine ?? '') as Engine;
  const svg = ENGINE_LOGO_SVG[key];
  if (svg) {
    const xml = getThemeMode() === 'dark' && MONO_ENGINE_LOGOS.has(key) ? svg.replace(/(fill|stroke)="(#003B57|#003545|#005571|black)"/g, `$1="${colors.text}"`) : svg;
    return <SvgXml xml={xml} width={size} height={size} />;
  }
  const png = ENGINE_LOGO_PNG[key];
  if (png) {
    return (
      <Image
        source={png}
        style={{ width: size, height: size, opacity: getThemeMode() === 'light' && BRIGHT_ENGINE_LOGOS.has(key) ? 0.88 : 1 }}
        resizeMode="contain"
      />
    );
  }
  const badge = LETTER_BADGES[key];
  return (
    <View style={{ width: size, height: size, borderRadius: 3, backgroundColor: `${badge?.color ?? colors.muted}33`, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: badge?.color ?? colors.muted, fontSize: Math.max(7, size * 0.55), fontWeight: '700' }}>{badge?.letter ?? '?'}</Text>
    </View>
  );
}

export function TextInput(props: React.ComponentProps<typeof RNTextInput>) {
  const webStyle = Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : undefined;
  return <RNTextInput {...props} style={[props.style, webStyle]} placeholder={props.placeholder ? translate(props.placeholder) : props.placeholder} />;
}

export function ScreenHeading({ icon, title, subtitle, action }: { icon: React.ReactNode; title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <View style={styles.screenHeading}>
      {icon}
      <View style={{ flex: 1 }}>
        <Text style={styles.screenTitle}>{title}</Text>
        {subtitle ? <Text style={styles.listMeta}>{subtitle}</Text> : null}
      </View>
      {action}
    </View>
  );
}
