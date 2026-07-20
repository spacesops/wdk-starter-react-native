import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/constants/colors';
import {
  formatZoneAttributeLabel,
  formatZoneAttributeValue,
  orderZoneAttributes,
  type VerifiedZoneSummary,
} from '@/utils/extract-zone-attributes';

type VerifiedZonesResultsProps = {
  zones: VerifiedZoneSummary[];
  verifyError?: string | null;
  verifyInfo?: string | null;
  requestedHandleFound?: boolean | null;
  isLoading?: boolean;
  loadingText?: string;
};

export default function VerifiedZonesResults({
  zones,
  verifyError,
  verifyInfo,
  requestedHandleFound = null,
  isLoading = false,
  loadingText = 'Verifying…',
}: VerifiedZonesResultsProps) {
  if (isLoading) {
    return (
      <View style={styles.statusRow}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
        <Text style={styles.statusText}>{loadingText}</Text>
      </View>
    );
  }

  return (
    <>
      {verifyInfo ? <Text style={styles.warningText}>{verifyInfo}</Text> : null}
      {verifyError ? (
        <Text
          style={
            requestedHandleFound === false && zones.length > 0
              ? styles.warningText
              : styles.errorText
          }
        >
          {verifyError}
        </Text>
      ) : null}
      {zones.length > 0 ? (
        <View style={styles.resultsSection}>
          {zones.map((zone, zoneIndex) => {
            const orderedAttributes = orderZoneAttributes(zone.attributes);
            const orderedFallbackAttributes = orderZoneAttributes(zone.fallbackAttributes);
            const hasFallback = orderedFallbackAttributes.length > 0;
            const isLastZone = zoneIndex === zones.length - 1;
            return (
              <View
                key={`${zone.handle}-${zone.canonical}`}
                style={[styles.zoneCard, isLastZone && styles.zoneCardLast]}
              >
                <Text style={styles.zoneTitle}>
                  {zone.handle}
                  <Text style={styles.zoneSovereignty}> → {zone.sovereignty}</Text>
                </Text>
                {zone.alias ? <Text style={styles.zoneMeta}>alias: {zone.alias}</Text> : null}
                {orderedAttributes.length === 0 && !hasFallback ? (
                  <Text style={styles.noRecords}>No published records</Text>
                ) : (
                  <>
                    {orderedAttributes.length === 0 ? (
                      <Text style={styles.noRecords}>No published records</Text>
                    ) : (
                      orderedAttributes.map((attr, attrIndex) => {
                        const isLastPrimary =
                          !hasFallback && attrIndex === orderedAttributes.length - 1;
                        return (
                          <View
                            key={`${zone.handle}-${attr.type}-${attr.key}`}
                            style={[styles.infoRow, isLastPrimary && styles.infoRowLast]}
                          >
                            <Text style={styles.infoLabel}>
                              {formatZoneAttributeLabel(attr)}
                            </Text>
                            <Text style={styles.infoValue} selectable>
                              {formatZoneAttributeValue(attr)}
                            </Text>
                          </View>
                        );
                      })
                    )}
                    {hasFallback ? (
                      <>
                        <Text style={styles.fallbackHeading}>Fallback</Text>
                        {orderedFallbackAttributes.map((attr, attrIndex) => {
                          const isLastFallback =
                            attrIndex === orderedFallbackAttributes.length - 1;
                          return (
                            <View
                              key={`${zone.handle}-fallback-${attr.type}-${attr.key}`}
                              style={[styles.infoRow, isLastFallback && styles.infoRowLast]}
                            >
                              <Text style={styles.infoLabel}>
                                {formatZoneAttributeLabel(attr)}
                              </Text>
                              <Text style={styles.infoValue} selectable>
                                {formatZoneAttributeValue(attr)}
                              </Text>
                            </View>
                          );
                        })}
                      </>
                    ) : null}
                  </>
                )}
              </View>
            );
          })}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  statusText: {
    fontSize: 14,
    color: colors.textSecondary,
  },
  errorText: {
    marginTop: 12,
    fontSize: 14,
    color: colors.error,
  },
  warningText: {
    marginTop: 12,
    fontSize: 14,
    color: colors.textSecondary,
  },
  resultsSection: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.borderDark,
    paddingTop: 12,
  },
  zoneCard: {
    marginBottom: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDark,
  },
  zoneCardLast: {
    marginBottom: 0,
    paddingBottom: 0,
    borderBottomWidth: 0,
  },
  zoneTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 8,
  },
  zoneSovereignty: {
    fontWeight: '500',
    color: colors.textSecondary,
  },
  zoneMeta: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: 8,
  },
  noRecords: {
    fontSize: 14,
    color: colors.textSecondary,
    fontStyle: 'italic',
  },
  fallbackHeading: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
    marginTop: 8,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDark,
    gap: 12,
  },
  infoRowLast: {
    borderBottomWidth: 0,
  },
  infoLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  infoValue: {
    flex: 1.4,
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'right',
  },
});
