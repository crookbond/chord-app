import { Linking, Pressable, Text, View } from 'react-native';

import { themed } from '@/theme';

// The full text is published at chordapp.ai. The open-source copy of Chord
// links to it instead of carrying its own copy, so there is one version.
const URL = 'https://chordapp.ai/tos';

export default function Terms() {
  return (
    <View style={styles.page}>
      <Text style={styles.title}>Terms of Service</Text>
      <Text style={styles.paragraph}>Read it at:</Text>
      <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(URL)}>
        <Text style={styles.link}>{URL}</Text>
      </Pressable>
    </View>
  );
}

const styles = themed((colors) => ({
  page: { flex: 1, backgroundColor: colors.bg, padding: 24 },
  title: { color: colors.text, fontSize: 24, fontWeight: '700', marginBottom: 12 },
  paragraph: { color: colors.text, fontSize: 15, marginBottom: 8 },
  link: { color: colors.accent, fontSize: 15, textDecorationLine: 'underline' },
}));
